import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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

import { createTestDb } from "../fixtures/helpers";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";

// Capture real modules before mocking
const _realConfig = await import("../../src/broker/config");
const _realWorker = await import("../../src/agents/worker");

mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => ({
    "pr-review": {
      description: "PR review",
      steps: [
        { id: "ci-check", type: "gate" as const, on_success: "review", on_failure: "verdict", label: "CI Check" },
        { id: "review", type: "worker" as const, on_success: "verdict", on_failure: "$fail", label: "Review" },
        { id: "verdict", type: "verdict" as const, on_success: "$done", on_failure: "$fail", label: "Verdict" },
      ],
    },
  }),
}));

mock.module("../../src/agents/worker", () => ({
  ..._realWorker,
  spawnWorker: mock(() => {}),
}));

const { _setDb } = await import("../../src/engine/step-engine");
// Must use require for onStepComplete since dynamic import caches the pre-mock version
const { onStepComplete } = require("../../src/engine/step-engine");

describe("verdict step execution", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
    _setDb(db);
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  test("verdict step sets status to waiting and paused", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index) VALUES (?, ?, 'active', 'tree-1', 'pr-review', 'review', 1)",
      ["T-300", "Review PR #42"],
    );

    onStepComplete("T-300", "success");

    const updated = db.taskGet("T-300")!;
    expect(updated.status).toBe("waiting");
    expect(updated.paused).toBe(1);
    expect(updated.current_step).toBe("verdict");
  });

  test("verdict step emits verdict_waiting event", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index) VALUES (?, ?, 'active', 'tree-1', 'pr-review', 'review', 1)",
      ["T-301", "Review PR #43"],
    );

    onStepComplete("T-301", "success");

    const events = db.eventsByTask("T-301");
    const verdictEvent = events.find(e => e.event_type === "verdict_waiting");
    expect(verdictEvent).toBeDefined();
  });
});
