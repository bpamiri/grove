import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  isAlive,
  parseCost,
  lastActivity,
  formatStreamLine,
  parseBrokerEvent,
} from "../../src/agents/stream-parser";

// Temp directory for JSONL fixture files
const TMP_DIR = join(tmpdir(), `grove-stream-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTmpFile(name: string, content: string): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// isAlive
// ---------------------------------------------------------------------------

describe("isAlive", () => {
  test("returns false for null/undefined", () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
  });

  test("returns false for zero or negative PID", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });

  test("returns true for current process PID", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isAlive(999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCost
// ---------------------------------------------------------------------------

describe("parseCost", () => {
  test("returns zeros for non-existent file", () => {
    const result = parseCost("/tmp/does-not-exist-ever.jsonl");
    expect(result).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("returns zeros for empty file", () => {
    const f = writeTmpFile("empty.jsonl", "");
    expect(parseCost(f)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("returns zeros when no result line present", () => {
    const f = writeTmpFile("no-result.jsonl", '{"type":"text","text":"hello"}\n{"type":"tool_use","name":"Read"}\n');
    expect(parseCost(f)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("extracts cost and tokens from result line", () => {
    const f = writeTmpFile("with-result.jsonl", [
      '{"type":"text","text":"working..."}',
      '{"type":"result","cost_usd":1.23,"usage":{"input_tokens":5000,"output_tokens":2000}}',
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 1.23, inputTokens: 5000, outputTokens: 2000 });
  });

  test("uses last result line when multiple present", () => {
    const f = writeTmpFile("multi-result.jsonl", [
      '{"type":"result","cost_usd":0.50,"usage":{"input_tokens":1000,"output_tokens":500}}',
      '{"type":"text","text":"resumed"}',
      '{"type":"result","cost_usd":2.00,"usage":{"input_tokens":8000,"output_tokens":3000}}',
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 2.0, inputTokens: 8000, outputTokens: 3000 });
  });

  test("skips garbage lines mixed with valid JSON", () => {
    const f = writeTmpFile("garbage.jsonl", [
      "not json at all",
      '{"type":"result","cost_usd":0.75,"usage":{"input_tokens":3000,"output_tokens":1000}}',
      "another garbage line",
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 0.75, inputTokens: 3000, outputTokens: 1000 });
  });
});

// ---------------------------------------------------------------------------
// lastActivity
// ---------------------------------------------------------------------------

describe("lastActivity", () => {
  test("returns 'no log' for non-existent file", () => {
    expect(lastActivity("/tmp/nope-never.jsonl")).toBe("no log");
  });

  test("returns 'idle' for empty file", () => {
    const f = writeTmpFile("empty-activity.jsonl", "");
    expect(lastActivity(f)).toBe("idle");
  });

  test("returns 'editing {file}' for edit tool_use", () => {
    const f = writeTmpFile("edit.jsonl", '{"type":"tool_use","tool":"Edit","input":{"file_path":"src/app.ts"}}\n');
    expect(lastActivity(f)).toBe("editing app.ts");
  });

  test("returns 'reading {file}' for read tool_use", () => {
    const f = writeTmpFile("read.jsonl", '{"type":"tool_use","tool":"Read","input":{"file_path":"src/config/db.ts"}}\n');
    expect(lastActivity(f)).toBe("reading db.ts");
  });

  test("returns 'running tests' for bash with test command", () => {
    const f = writeTmpFile("test-cmd.jsonl", '{"type":"tool_use","tool":"Bash","input":{"command":"bun test tests/"}}\n');
    expect(lastActivity(f)).toBe("running tests");
  });

  test("returns 'running git command' for bash with git", () => {
    const f = writeTmpFile("git-cmd.jsonl", '{"type":"tool_use","tool":"Bash","input":{"command":"git status"}}\n');
    expect(lastActivity(f)).toBe("running git command");
  });

  test("returns 'searching codebase' for grep/glob tool", () => {
    const f = writeTmpFile("grep.jsonl", '{"type":"tool_use","tool":"Grep","input":{"pattern":"TODO"}}\n');
    expect(lastActivity(f)).toBe("searching codebase");
  });

  test("returns 'completed' for result type", () => {
    const f = writeTmpFile("done.jsonl", [
      '{"type":"tool_use","tool":"Edit","input":{"file_path":"x.ts"}}',
      '{"type":"result","cost_usd":0.50}',
    ].join("\n"));
    expect(lastActivity(f)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// formatStreamLine
// ---------------------------------------------------------------------------

describe("formatStreamLine", () => {
  test("returns null for empty/whitespace", () => {
    expect(formatStreamLine("")).toBeNull();
    expect(formatStreamLine("   ")).toBeNull();
  });

  test("returns text type for non-JSON string", () => {
    const result = formatStreamLine("plain text output");
    expect(result).toEqual({ type: "text", text: "plain text output" });
  });

  test("returns text type for assistant message", () => {
    const result = formatStreamLine('{"type":"assistant","text":"I will fix the bug"}');
    expect(result).toEqual({ type: "text", text: "I will fix the bug" });
  });

  test("returns tool_use with name and detail", () => {
    const result = formatStreamLine('{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.ts"}}');
    expect(result!.type).toBe("tool_use");
    expect(result!.text).toContain("[Edit]");
    expect(result!.text).toContain("src/app.ts");
  });

  test("returns result with formatted cost", () => {
    const result = formatStreamLine('{"type":"result","cost_usd":1.5}');
    expect(result).toEqual({ type: "result", text: "Session complete. Cost: $1.50" });
  });

  test("returns error with message", () => {
    const result = formatStreamLine('{"type":"error","message":"Rate limited"}');
    expect(result).toEqual({ type: "error", text: "[error] Rate limited" });
  });
});

// ---------------------------------------------------------------------------
// parseBrokerEvent
// ---------------------------------------------------------------------------

describe("parseBrokerEvent", () => {
  test("returns null for empty string", () => {
    expect(parseBrokerEvent("")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseBrokerEvent("not json {")).toBeNull();
  });

  test("returns event for valid JSON with type field", () => {
    const event = parseBrokerEvent('{"type":"status","task":"W-001","msg":"running"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("status");
  });
});
