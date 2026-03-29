import { describe, test, expect, beforeEach } from "bun:test";
import { registerGrove, deregisterGrove } from "../../src/broker/registry";

const originalFetch = globalThis.fetch;

describe("registerGrove", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST with correct body and returns url", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (input: any, init: any) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true, url: "https://test.grove.cloud" }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await registerGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "abc123",
    });

    expect(capturedUrl).toBe("https://grove.cloud/_grove/register");
    expect(JSON.parse(capturedBody)).toEqual({
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "abc123",
    });
    expect(result).toBe("https://test.grove.cloud");
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });

    expect(registerGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "wrong",
    })).rejects.toThrow();
  });
});

describe("deregisterGrove", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends DELETE with correct body", async () => {
    let capturedMethod = "";
    let capturedBody = "";

    globalThis.fetch = async (_input: any, init: any) => {
      capturedMethod = init?.method;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true }));
    };

    await deregisterGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      secret: "abc123",
    });

    expect(capturedMethod).toBe("DELETE");
    expect(JSON.parse(capturedBody)).toEqual({
      subdomain: "test-sub",
      secret: "abc123",
    });
  });
});
