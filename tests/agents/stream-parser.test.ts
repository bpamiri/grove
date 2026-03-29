// Grove v3 — Stream parser unit tests
import { describe, test, expect } from "bun:test";
import { parseCost, lastActivity, formatStreamLine, parseBrokerEvent, isAlive } from "../../src/agents/stream-parser";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// parseCost
// ---------------------------------------------------------------------------

describe("parseCost", () => {
  test("extracts cost from result line", () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const logFile = join(dir, "session.jsonl");
    writeFileSync(logFile, [
      JSON.stringify({ type: "assistant", text: "Working on it..." }),
      JSON.stringify({ type: "result", cost_usd: 1.23, usage: { input_tokens: 500, output_tokens: 200 } }),
    ].join("\n"));

    const result = parseCost(logFile);
    expect(result.costUsd).toBe(1.23);
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(200);
  });

  test("returns zeros for non-existent file", () => {
    const result = parseCost("/tmp/grove-nonexistent-file-abc123.jsonl");
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test("handles empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const logFile = join(dir, "empty.jsonl");
    writeFileSync(logFile, "");

    const result = parseCost(logFile);
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatStreamLine
// ---------------------------------------------------------------------------

describe("formatStreamLine", () => {
  test("formats assistant text", () => {
    const result = formatStreamLine(JSON.stringify({ type: "assistant", text: "Hello world" }));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("Hello world");
  });

  test("formats tool_use", () => {
    const result = formatStreamLine(JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "/src/main.ts" } }));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_use");
    expect(result!.text).toContain("Read");
    expect(result!.text).toContain("/src/main.ts");
  });

  test("formats result with cost", () => {
    const result = formatStreamLine(JSON.stringify({ type: "result", cost_usd: 0.42 }));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("result");
    expect(result!.text).toContain("$0.42");
  });

  test("returns null for empty input", () => {
    expect(formatStreamLine("")).toBeNull();
    expect(formatStreamLine("   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBrokerEvent
// ---------------------------------------------------------------------------

describe("parseBrokerEvent", () => {
  test("parses valid broker event", () => {
    const line = JSON.stringify({ type: "spawn_worker", tree: "api", task: "W-001", prompt: "fix" });
    const result = parseBrokerEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("spawn_worker");
  });

  test("returns null for non-event JSON", () => {
    const result = parseBrokerEvent(JSON.stringify({ foo: "bar" }));
    expect(result).toBeNull();
  });

  test("returns null for non-JSON", () => {
    expect(parseBrokerEvent("not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAlive
// ---------------------------------------------------------------------------

describe("isAlive", () => {
  test("returns true for current process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("returns false for null/undefined/zero", () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });

  test("returns false for non-existent PID", () => {
    expect(isAlive(999999999)).toBe(false);
  });
});
