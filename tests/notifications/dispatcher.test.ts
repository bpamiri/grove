import { describe, test, expect, beforeEach } from "bun:test";
import { dispatch, resetRateLimiter } from "../../src/notifications/dispatcher";
import type { NotificationChannel, NotificationEvent } from "../../src/notifications/types";

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    name: "task_completed",
    taskId: "W-001",
    title: "Task Completed",
    body: "Task W-001 completed",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeChannel(name: string): NotificationChannel & { calls: NotificationEvent[] } {
  const calls: NotificationEvent[] = [];
  return {
    name,
    calls,
    async send(event: NotificationEvent) {
      calls.push(event);
    },
  };
}

describe("dispatch", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  test("dispatches to all channels", () => {
    const slack = makeChannel("slack");
    const system = makeChannel("system");
    const event = makeEvent();

    dispatch([slack, system], event);
    expect(slack.calls).toHaveLength(1);
    expect(system.calls).toHaveLength(1);
    expect(slack.calls[0].name).toBe("task_completed");
  });

  test("rate limits same event+task within 60s", () => {
    const ch = makeChannel("slack");

    dispatch([ch], makeEvent());
    dispatch([ch], makeEvent());
    dispatch([ch], makeEvent());

    expect(ch.calls).toHaveLength(1);
  });

  test("allows same event type for different tasks", () => {
    const ch = makeChannel("slack");

    dispatch([ch], makeEvent({ taskId: "W-001" }));
    dispatch([ch], makeEvent({ taskId: "W-002" }));

    expect(ch.calls).toHaveLength(2);
  });

  test("allows different event types for same task", () => {
    const ch = makeChannel("slack");

    dispatch([ch], makeEvent({ name: "task_completed" }));
    dispatch([ch], makeEvent({ name: "task_failed" }));

    expect(ch.calls).toHaveLength(2);
  });

  test("rate limits null taskId events globally", () => {
    const ch = makeChannel("slack");

    dispatch([ch], makeEvent({ name: "budget_warning", taskId: null }));
    dispatch([ch], makeEvent({ name: "budget_warning", taskId: null }));

    expect(ch.calls).toHaveLength(1);
  });

  test("channel errors are caught and do not propagate", () => {
    const failCh: NotificationChannel = {
      name: "slack",
      async send() {
        throw new Error("network error");
      },
    };
    const goodCh = makeChannel("webhook");

    // Should not throw
    dispatch([failCh, goodCh], makeEvent());
    expect(goodCh.calls).toHaveLength(1);
  });
});
