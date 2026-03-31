import { describe, test, expect } from "bun:test";
import { isSapEvent, parseSapEvent } from "../../src/shared/protocol";
import { ActivityRingBuffer } from "../../src/broker/ring-buffer";
import { BatchedBroadcaster } from "../../src/broker/batched-broadcaster";

describe("SAP event compliance", () => {
  test("agent:spawned event is valid SAP", () => {
    const event = { type: "agent:spawned", agentId: "w-1", role: "worker", taskId: "W-001", pid: 123, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:tool_use event is valid SAP", () => {
    const event = { type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Read", input: "src/a.ts", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:thinking event is valid SAP", () => {
    const event = { type: "agent:thinking", agentId: "w-1", taskId: "W-001", snippet: "Analyzing...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:cost event is valid SAP", () => {
    const event = { type: "agent:cost", agentId: "w-1", taskId: "W-001", costUsd: 0.05, tokens: 1500, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("seed:complete event is valid SAP", () => {
    const event = { type: "seed:complete", taskId: "W-001", summary: "Auth", spec: "## Spec", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("ring buffer stores and retrieves SAP events", () => {
    const buf = new ActivityRingBuffer(50);
    const event = { type: "agent:tool_use", taskId: "W-001", tool: "Edit", input: "a.ts", ts: Date.now() };
    buf.push("W-001", event);
    const events = buf.get("W-001");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent:tool_use");
  });

  test("batched broadcaster queues and flushes SAP events", async () => {
    const sent: string[] = [];
    const b = new BatchedBroadcaster(30, (msg) => sent.push(msg));
    b.queue("agent:tool_use", { taskId: "W-001", tool: "Read", ts: 1 });
    b.queue("agent:thinking", { taskId: "W-001", snippet: "hmm", ts: 2 });
    expect(sent.length).toBe(0);
    await new Promise(r => setTimeout(r, 50));
    expect(sent.length).toBe(2);
    // Verify each is valid JSON with SAP structure
    for (const msg of sent) {
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBeTruthy();
      expect(parsed.ts).toBeTruthy();
    }
    b.stop();
  });

  test("parseSapEvent round-trips correctly", () => {
    const event = { type: "agent:ended", agentId: "w-1", role: "worker", taskId: "W-001", exitCode: 0, ts: 12345 };
    const json = JSON.stringify(event);
    const parsed = parseSapEvent(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("agent:ended");
  });
});
