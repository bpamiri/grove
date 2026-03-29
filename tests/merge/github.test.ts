import { describe, test, expect } from "bun:test";
import { resolveCheckState } from "../../src/merge/github";

describe("resolveCheckState", () => {
  test("returns success when total is 0 (no CI checks configured)", () => {
    const result = resolveCheckState([]);
    expect(result.state).toBe("success");
    expect(result.total).toBe(0);
  });

  test("returns success when all checks pass", () => {
    const checks = [
      { name: "build", state: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", state: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const result = resolveCheckState(checks);
    expect(result.state).toBe("success");
    expect(result.passing).toBe(2);
    expect(result.total).toBe(2);
  });

  test("returns failure when any check fails", () => {
    const checks = [
      { name: "build", state: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", state: "COMPLETED", conclusion: "FAILURE" },
    ];
    const result = resolveCheckState(checks);
    expect(result.state).toBe("failure");
    expect(result.failing).toBe(1);
  });

  test("returns pending when checks are still running", () => {
    const checks = [
      { name: "build", state: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", state: "IN_PROGRESS", conclusion: "" },
    ];
    const result = resolveCheckState(checks);
    expect(result.state).toBe("pending");
    expect(result.pending).toBe(1);
  });
});
