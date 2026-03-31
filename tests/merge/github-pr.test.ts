import { describe, test, expect } from "bun:test";

describe("ghPrView", () => {
  test("is exported and callable", async () => {
    const { ghPrView } = await import("../../src/merge/github");
    expect(typeof ghPrView).toBe("function");
  });
});

describe("ghPrReview", () => {
  test("is exported and callable", async () => {
    const { ghPrReview } = await import("../../src/merge/github");
    expect(typeof ghPrReview).toBe("function");
  });
});

describe("ghPrClose", () => {
  test("is exported and callable", async () => {
    const { ghPrClose } = await import("../../src/merge/github");
    expect(typeof ghPrClose).toBe("function");
  });
});

describe("ghPrCheckout", () => {
  test("is exported and callable", async () => {
    const { ghPrCheckout } = await import("../../src/merge/github");
    expect(typeof ghPrCheckout).toBe("function");
  });
});
