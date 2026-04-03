import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";

// ---------------------------------------------------------------------------
// Test paths: merge step has result_file + skills (like the real config)
// ---------------------------------------------------------------------------

const TEST_PATHS = {
  development: {
    description: "Standard dev workflow",
    steps: [
      { id: "implement", type: "worker" as const, on_success: "merge", on_failure: "$fail", label: "Implement" },
      { id: "merge", type: "worker" as const, skills: ["merge-handler"], result_file: ".grove/merge-result.json", result_key: "merged", on_success: "$done", on_failure: "$fail", label: "Merge" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Mocks — spawnWorker throws when step has result_file + skills
// ---------------------------------------------------------------------------

const _realConfig = await import("../../src/broker/config");
const _realWorker = await import("../../src/agents/worker");

let shouldThrow = false;

mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => TEST_PATHS,
}));

mock.module("../../src/agents/worker", () => ({
  ..._realWorker,
  spawnWorker: mock((...args: any[]) => {
    if (shouldThrow) {
      throw new Error('Required skills missing for step "merge": merge-handler. Run "grove up" to bootstrap bundled skills.');
    }
  }),
}));

const { startPipeline, onStepComplete, _setDb } = await import("../../src/engine/step-engine");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("step engine handles spawnWorker errors", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
    _setDb(db);
    shouldThrow = false;
  });

  afterEach(async () => {
    bus.removeAll();
    shouldThrow = false;
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  function createTaskAt(id: string, step: string, stepIndex: number, opts: { retry_count?: number; max_retries?: number } = {}) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, retry_count, max_retries)
       VALUES (?, ?, 'active', 'tree-1', 'development', ?, ?, ?, ?)`,
      [id, `Task ${id}`, step, stepIndex, opts.retry_count ?? 0, opts.max_retries ?? 2],
    );
  }

  test("when spawnWorker throws, task fails fatally (no retries)", async () => {
    createTaskAt("T-SKL-001", "implement", 0, { retry_count: 0, max_retries: 2 });
    shouldThrow = true;

    onStepComplete("T-SKL-001", "success"); // implement succeeds → transitions to merge → spawnWorker throws

    // Wait for async executeStep to complete
    await new Promise((r) => setTimeout(r, 50));

    const updated = db.taskGet("T-SKL-001");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.current_step).toBe("$fail");
    // retry_count should NOT be incremented — fatal skips retries
    expect(updated!.retry_count).toBe(0);
  });

  test("when spawnWorker throws, actionable error is logged as event", async () => {
    createTaskAt("T-SKL-002", "implement", 0, { retry_count: 0, max_retries: 2 });
    shouldThrow = true;

    onStepComplete("T-SKL-002", "success"); // implement succeeds → merge → throw

    await new Promise((r) => setTimeout(r, 50));

    const events = db.eventsByTask("T-SKL-002");
    const failEvent = events.find(e => e.event_type === "task_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.summary).toContain("skills missing");
  });

  test("when spawnWorker succeeds, task proceeds normally", async () => {
    createTaskAt("T-SKL-003", "implement", 0);
    shouldThrow = false;

    onStepComplete("T-SKL-003", "success");

    await new Promise((r) => setTimeout(r, 50));

    const updated = db.taskGet("T-SKL-003")!;
    // Task should be at merge step (transitioned from implement)
    expect(updated.current_step).toBe("merge");
    expect(updated.status).toBe("active");
  });
});
