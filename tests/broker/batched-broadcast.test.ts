import { describe, test, expect } from "bun:test";
import { BatchedBroadcaster } from "../../src/broker/batched-broadcaster";

describe("BatchedBroadcaster", () => {
  test("flushes events after interval", async () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(50, (msg) => sent.push(msg));

    broadcaster.queue("agent:tool_use", { taskId: "W-001", tool: "Read", input: "a.ts", ts: 1 });
    broadcaster.queue("agent:tool_use", { taskId: "W-001", tool: "Edit", input: "b.ts", ts: 2 });

    expect(sent.length).toBe(0);
    await new Promise(r => setTimeout(r, 80));
    expect(sent.length).toBe(2);
    broadcaster.stop();
  });

  test("sends non-batched events immediately", () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(50, (msg) => sent.push(msg));

    broadcaster.sendImmediate("task:status", { taskId: "W-001", status: "active" });
    expect(sent.length).toBe(1);
    broadcaster.stop();
  });

  test("stop flushes remaining events", () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(1000, (msg) => sent.push(msg));

    broadcaster.queue("agent:thinking", { taskId: "W-001", snippet: "analyzing...", ts: 1 });
    broadcaster.stop();
    expect(sent.length).toBe(1);
  });
});
