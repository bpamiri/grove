import { describe, test, expect } from "bun:test";
import { AdapterRegistry } from "../../../src/agents/adapters/registry";
import { ClaudeCodeAdapter } from "../../../src/agents/adapters/claude-code";

describe("AdapterRegistry", () => {
  test("registers and retrieves adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeCodeAdapter();
    registry.register(adapter);
    expect(registry.get("claude-code")).toBe(adapter);
  });

  test("returns undefined for unknown adapter", () => {
    const registry = new AdapterRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("getDefault returns first registered adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeCodeAdapter();
    registry.register(adapter);
    expect(registry.getDefault()).toBe(adapter);
  });

  test("listAll returns all registered adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter());
    const all = registry.listAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe("claude-code");
  });
});

describe("ClaudeCodeAdapter", () => {
  test("name is claude-code", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.name).toBe("claude-code");
  });

  test("supportsResume is true", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.supportsResume).toBe(true);
  });

  test("parseOutputLine extracts tool_use from stream-json", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tool_use");
    expect(result!.tool).toBe("Read");
    expect(result!.input).toBe("src/a.ts");
  });

  test("parseOutputLine extracts thinking", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Analyzing the code..." }] },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("thinking");
    expect(result!.snippet).toBe("Analyzing the code...");
  });

  test("parseOutputLine extracts cost from result", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "result", cost_usd: 0.05, usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("cost");
    expect(result!.costUsd).toBe(0.05);
    expect(result!.tokens).toBe(1500);
  });

  test("parseOutputLine returns null for unparseable lines", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.parseOutputLine("not json")).toBeNull();
    expect(adapter.parseOutputLine("{}")).toBeNull();
  });
});
