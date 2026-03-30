import { describe, test, expect, beforeEach } from "bun:test";
import { signPayload, createWebhookChannel } from "../../src/notifications/channels/webhook";
import type { NotificationEvent } from "../../src/notifications/types";

const originalFetch = globalThis.fetch;

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    name: "task_completed",
    taskId: "W-001",
    title: "Task Completed",
    body: "Task W-001 completed",
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe("signPayload", () => {
  test("produces consistent HMAC-SHA256 hex digest", async () => {
    const sig1 = await signPayload("secret", "hello");
    const sig2 = await signPayload("secret", "hello");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 32 bytes = 64 hex chars
  });

  test("different secrets produce different signatures", async () => {
    const sig1 = await signPayload("secret-a", "hello");
    const sig2 = await signPayload("secret-b", "hello");
    expect(sig1).not.toBe(sig2);
  });

  test("different payloads produce different signatures", async () => {
    const sig1 = await signPayload("secret", "hello");
    const sig2 = await signPayload("secret", "world");
    expect(sig1).not.toBe(sig2);
  });
});

describe("createWebhookChannel", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends JSON with HMAC signature header", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    globalThis.fetch = async (_input: any, init: any) => {
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      capturedBody = init?.body;
      return new Response("ok");
    };

    const ch = createWebhookChannel({ url: "https://example.com/hook", secret: "test-secret" });
    await ch.send(makeEvent());

    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify signature matches the body
    const expectedSig = await signPayload("test-secret", capturedBody);
    expect(capturedHeaders["x-hub-signature-256"]).toBe(`sha256=${expectedSig}`);
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () => new Response("error", { status: 403 });

    const ch = createWebhookChannel({ url: "https://example.com/hook", secret: "s" });
    await expect(ch.send(makeEvent())).rejects.toThrow("Webhook returned 403");
  });
});
