import { describe, test, expect } from "bun:test";
import { normalizePath } from "../../src/engine/normalize";

describe("verdict step type", () => {
  test("'verdict' string infers verdict type", () => {
    const result = normalizePath({ description: "test", steps: ["verdict"] });
    expect(result.steps[0].type).toBe("verdict");
  });

  test("verdict step in pr-review path normalizes correctly", () => {
    const result = normalizePath({
      description: "PR review",
      steps: ["ci-check", "review", "verdict"],
    });
    expect(result.steps[0].type).toBe("gate");
    expect(result.steps[1].type).toBe("review");
    expect(result.steps[2].type).toBe("verdict");
    expect(result.steps[2].on_success).toBe("$done");
  });
});
