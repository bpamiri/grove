import { describe, test, expect } from "bun:test";
import { isSapEvent, parseSapEvent, type SapEvent } from "../../src/shared/protocol";

describe("isSapEvent", () => {
  test("validates agent:spawned event", () => {
    const event = { type: "agent:spawned", agentId: "w-1", role: "worker", taskId: "W-001", pid: 123, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates agent:tool_use event", () => {
    const event = { type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Read", input: "src/foo.ts", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates seed:response event", () => {
    const event = { type: "seed:response", taskId: "W-001", content: "Here's my analysis...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates seed:complete event", () => {
    const event = { type: "seed:complete", taskId: "W-001", summary: "Auth redesign", spec: "## Spec\n...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("rejects event without type", () => {
    expect(isSapEvent({ agentId: "w-1", taskId: "W-001" })).toBe(false);
  });

  test("rejects event without ts", () => {
    expect(isSapEvent({ type: "agent:spawned", agentId: "w-1" })).toBe(false);
  });

  test("rejects unknown event type", () => {
    expect(isSapEvent({ type: "unknown:event", ts: Date.now() })).toBe(false);
  });
});

describe("parseSapEvent", () => {
  test("parses valid JSON string into SapEvent", () => {
    const json = JSON.stringify({ type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Edit", input: "src/a.ts", ts: 1234 });
    const event = parseSapEvent(json);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("agent:tool_use");
  });

  test("returns null for invalid JSON", () => {
    expect(parseSapEvent("not json")).toBeNull();
  });

  test("returns null for non-SAP object", () => {
    expect(parseSapEvent(JSON.stringify({ foo: "bar" }))).toBeNull();
  });
});
