import { describe, test, expect } from "bun:test";
import { generateSubdomain, generateSecret } from "../../src/broker/subdomain";

describe("generateSubdomain", () => {
  test("returns word-word-suffix format", () => {
    const sub = generateSubdomain();
    expect(sub).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  test("generates unique values", () => {
    const a = generateSubdomain();
    const b = generateSubdomain();
    expect(a).not.toBe(b);
  });
});

describe("generateSecret", () => {
  test("returns 32-char hex string", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[a-f0-9]{32}$/);
    expect(secret.length).toBe(32);
  });

  test("generates unique values", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});
