// Tests for monitor functions (parseCost, lastActivity, isAlive)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCost, lastActivity, isAlive } from "../../src/lib/monitor";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-monitor-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("parseCost", () => {
  test("returns zeros for nonexistent file", () => {
    const result = parseCost("/nonexistent/file.log");
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test("returns zeros for empty file", () => {
    const logFile = join(tempDir, "empty.log");
    writeFileSync(logFile, "");
    const result = parseCost(logFile);
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test("parses result event with cost and usage", () => {
    const logFile = join(tempDir, "session.log");
    const lines = [
      JSON.stringify({ type: "assistant", text: "I will fix the bug" }),
      JSON.stringify({ type: "tool_use", tool: "Edit", input: { file_path: "src/app.ts" } }),
      JSON.stringify({
        type: "result",
        cost_usd: 1.23,
        usage: { input_tokens: 5000, output_tokens: 2000 },
      }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    const result = parseCost(logFile);
    expect(result.costUsd).toBe(1.23);
    expect(result.inputTokens).toBe(5000);
    expect(result.outputTokens).toBe(2000);
  });

  test("uses last result event when multiple exist", () => {
    const logFile = join(tempDir, "multi.log");
    const lines = [
      JSON.stringify({
        type: "result",
        cost_usd: 0.5,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
      JSON.stringify({
        type: "result",
        cost_usd: 2.5,
        usage: { input_tokens: 8000, output_tokens: 3000 },
      }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    const result = parseCost(logFile);
    expect(result.costUsd).toBe(2.5);
    expect(result.inputTokens).toBe(8000);
    expect(result.outputTokens).toBe(3000);
  });

  test("handles non-JSON lines gracefully", () => {
    const logFile = join(tempDir, "mixed.log");
    const lines = [
      "This is not JSON",
      "Another non-JSON line",
      JSON.stringify({
        type: "result",
        cost_usd: 0.75,
        usage: { input_tokens: 3000, output_tokens: 1500 },
      }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    const result = parseCost(logFile);
    expect(result.costUsd).toBe(0.75);
  });
});

describe("lastActivity", () => {
  test("returns 'no log file' for nonexistent file", () => {
    expect(lastActivity("/nonexistent/file.log")).toBe("no log file");
  });

  test("returns 'idle' for empty file", () => {
    const logFile = join(tempDir, "empty.log");
    writeFileSync(logFile, "");
    expect(lastActivity(logFile)).toBe("idle");
  });

  test("detects editing activity", () => {
    const logFile = join(tempDir, "edit.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Edit", input: { file_path: "/src/router.ts" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("editing router.ts");
  });

  test("detects reading activity", () => {
    const logFile = join(tempDir, "read.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Read", input: { file_path: "/src/config.ts" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("reading config.ts");
  });

  test("detects running tests", () => {
    const logFile = join(tempDir, "test.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Bash", input: { command: "bun test" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("running tests");
  });

  test("detects git commands", () => {
    const logFile = join(tempDir, "git.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Bash", input: { command: "git status" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("running git command");
  });

  test("detects searching", () => {
    const logFile = join(tempDir, "search.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Grep", input: { pattern: "router" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("searching codebase");
  });

  test("detects thinking from assistant messages", () => {
    const logFile = join(tempDir, "think.log");
    const lines = [
      JSON.stringify({ type: "assistant", text: "Let me analyze this problem and figure out the best approach" }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("thinking");
  });

  test("detects completion from result event", () => {
    const logFile = join(tempDir, "done.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Edit", input: { file_path: "/src/app.ts" } }),
      JSON.stringify({ type: "result", cost_usd: 1.0 }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("completed");
  });

  test("returns last activity when multiple events", () => {
    const logFile = join(tempDir, "multi.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Read", input: { file_path: "/src/a.ts" } }),
      JSON.stringify({ type: "tool_use", tool: "Edit", input: { file_path: "/src/b.ts" } }),
      JSON.stringify({ type: "tool_use", tool: "Grep", input: { pattern: "todo" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    // Last tool use was Grep -> searching
    expect(lastActivity(logFile)).toBe("searching codebase");
  });

  test("detects installing dependencies", () => {
    const logFile = join(tempDir, "install.log");
    const lines = [
      JSON.stringify({ type: "tool_use", tool: "Bash", input: { command: "npm install lodash" } }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    expect(lastActivity(logFile)).toBe("installing dependencies");
  });
});

describe("isAlive", () => {
  test("returns true for current process PID", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("returns false for very high PID (unlikely to exist)", () => {
    expect(isAlive(99999999)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isAlive(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isAlive(undefined)).toBe(false);
  });

  test("returns false for 0", () => {
    expect(isAlive(0)).toBe(false);
  });

  test("returns false for negative PID", () => {
    expect(isAlive(-1)).toBe(false);
  });
});
