import { describe, test, expect } from "bun:test";
import { bus } from "../../src/broker/event-bus";

describe("EventBus", () => {
  test("emits and receives events", () => {
    let received: any = null;
    const unsub = bus.on("broker:started", (data) => {
      received = data;
    });

    bus.emit("broker:started", { port: 3000, url: "http://localhost:3000" });
    expect(received).toEqual({ port: 3000, url: "http://localhost:3000" });
    unsub();
  });

  test("unsubscribe stops receiving", () => {
    let count = 0;
    const unsub = bus.on("broker:stopped", () => { count++; });

    bus.emit("broker:stopped", undefined);
    expect(count).toBe(1);

    unsub();
    bus.emit("broker:stopped", undefined);
    expect(count).toBe(1);
  });

  test("multiple handlers for same event", () => {
    let a = 0, b = 0;
    const unsub1 = bus.on("task:status", () => { a++; });
    const unsub2 = bus.on("task:status", () => { b++; });

    bus.emit("task:status", { taskId: "W-001", status: "running" });
    expect(a).toBe(1);
    expect(b).toBe(1);

    unsub1();
    unsub2();
  });

  test("handler errors don't break other handlers", () => {
    let reached = false;
    const unsub1 = bus.on("worker:spawned", () => { throw new Error("boom"); });
    const unsub2 = bus.on("worker:spawned", () => { reached = true; });

    // Should not throw
    bus.emit("worker:spawned", { taskId: "W-001", sessionId: "s-001", pid: 123 });
    expect(reached).toBe(true);

    unsub1();
    unsub2();
  });

  test("listenerCount returns correct count", () => {
    const unsub1 = bus.on("cost:updated", () => {});
    const unsub2 = bus.on("cost:updated", () => {});
    expect(bus.listenerCount("cost:updated")).toBe(2);

    unsub1();
    expect(bus.listenerCount("cost:updated")).toBe(1);

    unsub2();
    expect(bus.listenerCount("cost:updated")).toBe(0);
  });

  test("removeAll clears handlers for event", () => {
    bus.on("message:new", () => {});
    bus.on("message:new", () => {});
    expect(bus.listenerCount("message:new")).toBe(2);

    bus.removeAll("message:new");
    expect(bus.listenerCount("message:new")).toBe(0);
  });
});
