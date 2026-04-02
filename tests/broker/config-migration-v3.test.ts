import { describe, test, expect } from "bun:test";
import { migrateV2toV3 } from "../../src/broker/config";

describe("v2 to v3 config migration", () => {
  test("converts gate step to worker with code-review skill", () => {
    const v2 = {
      version: 2,
      paths: {
        development: {
          description: "test",
          steps: [
            { id: "implement", type: "worker" },
            { id: "evaluate", type: "gate", on_failure: "implement" },
            { id: "merge", type: "merge" },
          ],
        },
      },
    };
    const v3 = migrateV2toV3(v2);
    expect(v3.version).toBe(3);

    const steps = v3.paths.development.steps;
    expect(steps[1].type).toBe("worker");
    expect(steps[1].skills).toEqual(["code-review"]);
    expect(steps[1].sandbox).toBe("read-only");
    expect(steps[1].result_file).toBe(".grove/review-result.json");
    expect(steps[1].result_key).toBe("approved");

    expect(steps[2].type).toBe("worker");
    expect(steps[2].skills).toEqual(["merge-handler"]);
    expect(steps[2].result_file).toBe(".grove/merge-result.json");
    expect(steps[2].result_key).toBe("merged");
  });

  test("converts review step to worker with read-only sandbox", () => {
    const v2 = {
      version: 2,
      paths: {
        adversarial: {
          description: "test",
          steps: [
            { id: "plan", type: "worker" },
            { id: "review", type: "review", prompt: "Critique this plan.", on_failure: "plan" },
          ],
        },
      },
    };
    const v3 = migrateV2toV3(v2);
    const reviewStep = v3.paths.adversarial.steps[1];
    expect(reviewStep.type).toBe("worker");
    expect(reviewStep.sandbox).toBe("read-only");
    expect(reviewStep.prompt).toBe("Critique this plan.");
    expect(reviewStep.result_file).toBe(".grove/review-result.json");
    expect(reviewStep.result_key).toBe("approved");
  });

  test("preserves worker steps unchanged", () => {
    const v2 = {
      version: 2,
      paths: {
        simple: {
          description: "test",
          steps: [
            { id: "implement", type: "worker", prompt: "Do the thing" },
          ],
        },
      },
    };
    const v3 = migrateV2toV3(v2);
    expect(v3.paths.simple.steps[0].type).toBe("worker");
    expect(v3.paths.simple.steps[0].prompt).toBe("Do the thing");
  });

  test("handles config without paths", () => {
    const v2 = { version: 2, workspace: { name: "test" } };
    const v3 = migrateV2toV3(v2);
    expect(v3.version).toBe(3);
  });
});
