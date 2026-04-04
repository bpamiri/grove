import { describe, test, expect } from "bun:test";
import { normalizePath } from "../../src/engine/normalize";
import { DEFAULT_PATHS } from "../../src/shared/types";

describe("v3 path normalization", () => {
  test("normalizes step with skills array", () => {
    const result = normalizePath({
      description: "test",
      steps: [
        { id: "review", type: "worker", skills: ["code-review"], sandbox: "read-only",
          result_file: ".grove/review-result.json", result_key: "approved", on_failure: "$fail" },
      ],
    });
    expect(result.steps[0].skills).toEqual(["code-review"]);
    expect(result.steps[0].sandbox).toBe("read-only");
    expect(result.steps[0].result_file).toBe(".grove/review-result.json");
    expect(result.steps[0].result_key).toBe("approved");
  });

  test("defaults sandbox to read-write", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "implement", type: "worker" }],
    });
    expect(result.steps[0].sandbox).toBe("read-write");
  });

  test("read-only steps auto-fill on_failure to preceding worker", () => {
    const result = normalizePath({
      description: "test",
      steps: [
        { id: "implement", type: "worker" },
        { id: "review", type: "worker", sandbox: "read-only" },
      ],
    });
    expect(result.steps[1].on_failure).toBe("implement");
  });

  test("string step shorthand defaults to worker with read-write", () => {
    const result = normalizePath({
      description: "test",
      steps: ["implement", "review"],
    });
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[0].sandbox).toBe("read-write");
    expect(result.steps[1].type).toBe("worker");
  });

  test("verdict type is preserved", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "decide", type: "verdict" }],
    });
    expect(result.steps[0].type).toBe("verdict");
  });

  test("unknown type falls back to worker", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "evaluate", type: "gate" }],
    });
    expect(result.steps[0].type).toBe("worker");
  });
});

describe("refactoring path normalization", () => {
  test("DEFAULT_PATHS includes refactoring", () => {
    expect(DEFAULT_PATHS.refactoring).toBeDefined();
    expect(DEFAULT_PATHS.refactoring.description).toContain("refactoring");
  });

  test("refactoring path has all 6 steps", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    expect(result.steps).toHaveLength(6);
    const ids = result.steps.map(s => s.id);
    expect(ids).toEqual(["analyze", "plan", "implement", "verify", "review", "merge"]);
  });

  test("analyze and plan steps inject refactoring skill", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    expect(result.steps[0].skills).toEqual(["refactoring"]);
    expect(result.steps[1].skills).toEqual(["refactoring"]);
  });

  test("verify step uses result_file for gate-like behavior", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    const verify = result.steps.find(s => s.id === "verify")!;
    expect(verify.result_file).toBe(".grove/verify-result.json");
    expect(verify.result_key).toBe("tests_passed");
    expect(verify.on_failure).toBe("implement");
  });

  test("review step is read-only and loops back to implement on failure", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    const review = result.steps.find(s => s.id === "review")!;
    expect(review.sandbox).toBe("read-only");
    expect(review.on_failure).toBe("implement");
    expect(review.skills).toEqual(["code-review"]);
  });

  test("step transitions chain correctly", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    expect(result.steps[0].on_success).toBe("plan");       // analyze → plan
    expect(result.steps[1].on_success).toBe("implement");   // plan → implement
    expect(result.steps[2].on_success).toBe("verify");      // implement → verify
    expect(result.steps[3].on_success).toBe("review");      // verify → review
    expect(result.steps[4].on_success).toBe("merge");       // review → merge
    expect(result.steps[5].on_success).toBe("$done");       // merge → done
  });

  test("merge step uses merge-handler skill", () => {
    const result = normalizePath(DEFAULT_PATHS.refactoring);
    const merge = result.steps.find(s => s.id === "merge")!;
    expect(merge.skills).toEqual(["merge-handler"]);
    expect(merge.result_file).toBe(".grove/merge-result.json");
    expect(merge.result_key).toBe("merged");
  });
});
