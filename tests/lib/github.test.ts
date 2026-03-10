import { describe, test, expect } from "bun:test";

// We can't test actual gh calls without network, so we test the module exports exist
// and validate types. Integration testing happens in Task 6.
describe("github module exports", () => {
  test("ghPrCreate is exported", async () => {
    const mod = await import("../../src/lib/github");
    expect(typeof mod.ghPrCreate).toBe("function");
  });

  test("ghPrList is exported", async () => {
    const mod = await import("../../src/lib/github");
    expect(typeof mod.ghPrList).toBe("function");
  });
});
