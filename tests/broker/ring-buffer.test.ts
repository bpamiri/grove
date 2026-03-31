import { describe, test, expect } from "bun:test";
import { ActivityRingBuffer } from "../../src/broker/ring-buffer";

describe("ActivityRingBuffer", () => {
  test("stores and retrieves events", () => {
    const buf = new ActivityRingBuffer(5);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "src/a.ts", ts: 1000 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Edit", input: "src/b.ts", ts: 2000 });
    const events = buf.get("W-001");
    expect(events.length).toBe(2);
    expect(events[0].tool).toBe("Read");
    expect(events[1].tool).toBe("Edit");
  });

  test("evicts oldest when full", () => {
    const buf = new ActivityRingBuffer(3);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "A", input: "", ts: 1 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "B", input: "", ts: 2 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "C", input: "", ts: 3 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "D", input: "", ts: 4 });
    const events = buf.get("W-001");
    expect(events.length).toBe(3);
    expect(events[0].tool).toBe("B");
    expect(events[2].tool).toBe("D");
  });

  test("isolates tasks", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "", ts: 1 });
    buf.push("W-002", { type: "agent:tool_use", taskId: "W-002", tool: "Edit", input: "", ts: 2 });
    expect(buf.get("W-001").length).toBe(1);
    expect(buf.get("W-002").length).toBe(1);
    expect(buf.get("W-003").length).toBe(0);
  });

  test("clear removes task events", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "", ts: 1 });
    buf.clear("W-001");
    expect(buf.get("W-001").length).toBe(0);
  });

  test("clearAll empties everything", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "A", input: "", ts: 1 });
    buf.push("W-002", { type: "agent:tool_use", taskId: "W-002", tool: "B", input: "", ts: 2 });
    buf.clearAll();
    expect(buf.get("W-001").length).toBe(0);
    expect(buf.get("W-002").length).toBe(0);
  });
});
