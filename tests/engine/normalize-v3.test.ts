import { describe, test, expect } from "bun:test";
import { normalizePath } from "../../src/engine/normalize";

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
