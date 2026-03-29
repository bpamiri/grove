import { describe, test, expect } from "bun:test";
import { resolveCheckState, resolveMergeableState, isTrivialConflict, TRIVIAL_CONFLICT_PATTERNS } from "../../src/merge/github";

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

describe("resolveMergeableState", () => {
  test("returns MERGEABLE for clean PR", () => {
    expect(resolveMergeableState("MERGEABLE")).toBe("MERGEABLE");
  });

  test("returns CONFLICTING for conflicting PR", () => {
    expect(resolveMergeableState("CONFLICTING")).toBe("CONFLICTING");
  });

  test("returns UNKNOWN for unknown state", () => {
    expect(resolveMergeableState("UNKNOWN")).toBe("UNKNOWN");
  });

  test("handles case-insensitive input", () => {
    expect(resolveMergeableState("mergeable")).toBe("MERGEABLE");
    expect(resolveMergeableState("Conflicting")).toBe("CONFLICTING");
  });

  test("returns UNKNOWN for empty string", () => {
    expect(resolveMergeableState("")).toBe("UNKNOWN");
  });

  test("returns UNKNOWN for unexpected values", () => {
    expect(resolveMergeableState("DIRTY")).toBe("UNKNOWN");
    expect(resolveMergeableState("CLEAN")).toBe("UNKNOWN");
  });
});

describe("isTrivialConflict", () => {
  test("recognizes common lockfiles as trivial", () => {
    for (const pattern of TRIVIAL_CONFLICT_PATTERNS) {
      expect(isTrivialConflict(pattern)).toBe(true);
    }
  });

  test("recognizes lockfiles with paths as trivial", () => {
    expect(isTrivialConflict("packages/web/package-lock.json")).toBe(true);
    expect(isTrivialConflict("frontend/yarn.lock")).toBe(true);
    expect(isTrivialConflict("deep/nested/path/bun.lockb")).toBe(true);
  });

  test("rejects source code files", () => {
    expect(isTrivialConflict("src/index.ts")).toBe(false);
    expect(isTrivialConflict("README.md")).toBe(false);
    expect(isTrivialConflict("package.json")).toBe(false);
  });

  test("rejects files that partially match lockfile names", () => {
    expect(isTrivialConflict("package-lock.json.bak")).toBe(false);
    expect(isTrivialConflict("my-package-lock.json")).toBe(false);
  });
});
