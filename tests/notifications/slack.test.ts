import { describe, test, expect, beforeEach } from "bun:test";
import { buildSlackPayload, createSlackChannel } from "../../src/notifications/channels/slack";
import type { NotificationEvent } from "../../src/notifications/types";

const originalFetch = globalThis.fetch;

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    name: "task_completed",
    taskId: "W-001",
    title: "Task Completed",
    body: "Task W-001 completed successfully",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("buildSlackPayload", () => {
  test("includes text fallback and attachment with color", () => {
    const payload = buildSlackPayload(makeEvent()) as any;

    expect(payload.text).toContain("Task Completed");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].color).toBe("#2eb67d"); // green for completed
    expect(payload.attachments[0].blocks).toHaveLength(2);
    expect(payload.attachments[0].blocks[0].type).toBe("header");
    expect(payload.attachments[0].blocks[1].type).toBe("section");
  });

  test("uses red for failure events", () => {
    const payload = buildSlackPayload(makeEvent({ name: "task_failed" })) as any;
    expect(payload.attachments[0].color).toBe("#e01e5a");
  });

  test("uses yellow for budget warning", () => {
    const payload = buildSlackPayload(makeEvent({ name: "budget_warning" })) as any;
    expect(payload.attachments[0].color).toBe("#ecb22e");
  });
});

describe("createSlackChannel", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts payload to webhook URL", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (input: any, init: any) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body;
      return new Response("ok");
    };

    const ch = createSlackChannel({ webhook_url: "https://hooks.slack.com/test" });
    await ch.send(makeEvent());

    expect(capturedUrl).toBe("https://hooks.slack.com/test");
    const body = JSON.parse(capturedBody);
    expect(body.text).toContain("Task Completed");
    expect(body.attachments[0].color).toBe("#2eb67d");
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () => new Response("error", { status: 500 });

    const ch = createSlackChannel({ webhook_url: "https://hooks.slack.com/test" });
    await expect(ch.send(makeEvent())).rejects.toThrow("Slack webhook returned 500");
  });
});
