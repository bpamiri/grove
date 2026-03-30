import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { normalizePath, normalizeAllPaths, stripPrompts } from "../../src/engine/normalize";
import { createTestDb } from "../fixtures/helpers";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";

// ---------------------------------------------------------------------------
// normalizePath / normalizeAllPaths / stripPrompts  (pure — no mocking)
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  test("string step 'implement' becomes worker type", () => {
    const result = normalizePath({ description: "test", steps: ["implement"] });
    expect(result.steps[0].id).toBe("implement");
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[0].on_success).toBe("$done");
    expect(result.steps[0].on_failure).toBe("$fail");
  });

  test("string step 'merge' infers merge type", () => {
    const result = normalizePath({ description: "test", steps: ["merge"] });
    expect(result.steps[0].type).toBe("merge");
  });

  test("string step 'evaluate' infers gate type", () => {
    const result = normalizePath({ description: "test", steps: ["evaluate"] });
    expect(result.steps[0].type).toBe("gate");
  });

  test("object step with id key uses explicit props", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "custom", type: "worker", on_success: "$done", on_failure: "$fail", prompt: "Do stuff" }],
    });
    expect(result.steps[0].id).toBe("custom");
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[0].prompt).toBe("Do stuff");
  });

  test("object shorthand extracts id from key", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ plan: { prompt: "Plan the work" } }],
    });
    expect(result.steps[0].id).toBe("plan");
    expect(result.steps[0].prompt).toBe("Plan the work");
  });

  test("auto-wires on_success for intermediate steps to next step", () => {
    const result = normalizePath({
      description: "test",
      steps: ["plan", "implement", "evaluate"],
    });
    expect(result.steps[0].on_success).toBe("implement");
    expect(result.steps[1].on_success).toBe("evaluate");
    expect(result.steps[2].on_success).toBe("$done");
  });

  test("on_failure defaults to $fail", () => {
    const result = normalizePath({ description: "test", steps: ["plan", "implement"] });
    expect(result.steps[0].on_failure).toBe("$fail");
    expect(result.steps[1].on_failure).toBe("$fail");
  });

  test("auto-capitalizes label", () => {
    const result = normalizePath({ description: "test", steps: ["implement"] });
    expect(result.steps[0].label).toBe("Implement");
  });

  test("gate step on_failure defaults to nearest preceding worker", () => {
    const result = normalizePath({
      description: "test",
      steps: ["plan", "implement", "evaluate", "merge"],
    });
    expect(result.steps[2].type).toBe("gate");
    expect(result.steps[2].on_failure).toBe("implement");
  });

  test("gate step with no preceding worker defaults on_failure to $fail", () => {
    const result = normalizePath({ description: "test", steps: ["evaluate"] });
    expect(result.steps[0].type).toBe("gate");
    expect(result.steps[0].on_failure).toBe("$fail");
  });

  test("multi-step path wires full chain correctly", () => {
    const result = normalizePath({
      description: "dev",
      steps: [
        { plan: { type: "worker", prompt: "Plan" } },
        { implement: { type: "worker", prompt: "Build" } },
        { evaluate: { on_failure: "implement" } },
        "merge",
      ],
    });
    expect(result.steps.length).toBe(4);
    expect(result.steps[0].on_success).toBe("implement");
    expect(result.steps[1].on_success).toBe("evaluate");
    expect(result.steps[2].on_success).toBe("merge");
    expect(result.steps[2].on_failure).toBe("implement");
    expect(result.steps[3].on_success).toBe("$done");
  });
});

describe("stripPrompts", () => {
  test("removes prompt fields from all steps", () => {
    const paths = normalizeAllPaths({
      dev: {
        description: "dev",
        steps: [{ plan: { prompt: "secret prompt" } }, "implement"],
      },
    });
    const stripped = stripPrompts(paths);
    expect(stripped.dev.steps[0].prompt).toBeUndefined();
    expect(stripped.dev.steps[0].id).toBe("plan");
    expect(stripped.dev.steps[1].id).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// Pipeline tests (require module mocking)
// ---------------------------------------------------------------------------

const TEST_PATHS = {
  development: {
    description: "Standard dev workflow",
    steps: [
      { id: "plan", type: "worker" as const, on_success: "implement", on_failure: "$fail", label: "Plan" },
      { id: "implement", type: "worker" as const, on_success: "evaluate", on_failure: "$fail", label: "Implement" },
      { id: "evaluate", type: "gate" as const, on_success: "merge", on_failure: "implement", label: "Evaluate", max_retries: 2 },
      { id: "merge", type: "merge" as const, on_success: "$done", on_failure: "$fail", label: "Merge" },
    ],
  },
};

// Capture real module references BEFORE mocking.
// Bun's mock.module is process-global — it replaces the module for ALL test files.
// By capturing first, we can spread real exports into each mock and only override
// what the step-engine tests need, preserving everything for other test files.
// Capture real module references BEFORE mocking.
// Bun's mock.module is process-global — we must spread real exports so other
// test files that import these modules still get the real functions.
// Only mock modules that would cause side effects (spawning processes).
const _realConfig = await import("../../src/broker/config");
const _realWorker = await import("../../src/agents/worker");

// config: override configNormalizedPaths only, preserve all other config functions
mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => TEST_PATHS,
}));

// worker: override spawnWorker to prevent spawning Claude Code processes
mock.module("../../src/agents/worker", () => ({
  ..._realWorker,
  spawnWorker: mock(() => {}),
}));

// Dynamic import AFTER mocks are set up
const { startPipeline, onStepComplete } = await import("../../src/engine/step-engine");

describe("startPipeline", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
  });

  afterEach(() => {
    bus.removeAll();
    cleanup();
  });

  function createTask(id: string, opts: { path_name?: string; tree_id?: string } = {}) {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name) VALUES (?, ?, 'draft', ?, ?)",
      [id, `Task ${id}`, opts.tree_id ?? "tree-1", opts.path_name ?? "development"],
    );
    return db.taskGet(id)!;
  }

  test("valid path sets task active with current_step = first step", () => {
    const task = createTask("T-001");
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-001")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("plan");
    expect(updated.step_index).toBe(0);
  });

  test("missing path fails the task", () => {
    const task = createTask("T-002", { path_name: "nonexistent" });
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-002")!;
    expect(updated.status).toBe("failed");
  });

  test("seeded task with first step 'plan' worker skips to next step", () => {
    const task = createTask("T-003");
    const tree = db.treeGet("tree-1")!;

    // Create a completed seed with spec
    db.seedCreate("T-003");
    db.seedComplete("T-003", "summary", "detailed spec");

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-003")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
  });

  test("seeded task where first step is not 'plan' does not skip", () => {
    // Override TEST_PATHS temporarily by using a path whose first step is "implement"
    const origPaths = { ...TEST_PATHS };
    const customPaths = {
      custom: {
        description: "custom",
        steps: [
          { id: "implement", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Implement" },
        ],
      },
    };
    // Temporarily add custom path
    (TEST_PATHS as any).custom = customPaths.custom;

    const task = createTask("T-004", { path_name: "custom" });
    const tree = db.treeGet("tree-1")!;

    db.seedCreate("T-004");
    db.seedComplete("T-004", "summary", "spec");

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-004")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(0);

    // Clean up
    delete (TEST_PATHS as any).custom;
  });

  test("single-step 'plan' path with seed does not skip (can't skip only step)", () => {
    (TEST_PATHS as any).solo = {
      description: "solo plan",
      steps: [
        { id: "plan", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Plan" },
      ],
    };

    const task = createTask("T-005", { path_name: "solo" });
    const tree = db.treeGet("tree-1")!;

    db.seedCreate("T-005");
    db.seedComplete("T-005", "summary", "spec");

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-005")!;
    // Can't skip the only step
    expect(updated.current_step).toBe("plan");
    expect(updated.step_index).toBe(0);

    delete (TEST_PATHS as any).solo;
  });
});

describe("onStepComplete", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });

    // CRITICAL: call startPipeline on a throwaway task to set module-level _db
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name) VALUES (?, ?, 'draft', 'tree-1', 'development')",
      ["SETUP-001", "Setup Task"],
    );
    const setupTask = db.taskGet("SETUP-001")!;
    const tree = db.treeGet("tree-1")!;
    startPipeline(setupTask, tree, db);
  });

  afterEach(() => {
    bus.removeAll();
    cleanup();
  });

  function createTaskAt(id: string, step: string, stepIndex: number, opts: { retry_count?: number; max_retries?: number; path_name?: string } = {}) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, retry_count, max_retries)
       VALUES (?, ?, 'active', 'tree-1', ?, ?, ?, ?, ?)`,
      [
        id,
        `Task ${id}`,
        opts.path_name ?? "development",
        step,
        stepIndex,
        opts.retry_count ?? 0,
        opts.max_retries ?? 2,
      ],
    );
  }

  test("merge step success ($done) completes the task", () => {
    createTaskAt("T-100", "merge", 3);

    onStepComplete("T-100", "success");

    const updated = db.taskGet("T-100")!;
    expect(updated.status).toBe("completed");
    expect(updated.current_step).toBe("$done");
    expect(updated.completed_at).not.toBeNull();
  });

  test("plan step success transitions to implement", () => {
    createTaskAt("T-101", "plan", 0);

    onStepComplete("T-101", "success");

    const updated = db.taskGet("T-101")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
    expect(updated.status).toBe("active");
  });

  test("plan step failure with retries remaining increments retry_count", () => {
    createTaskAt("T-102", "plan", 0, { retry_count: 0, max_retries: 2 });

    onStepComplete("T-102", "failure");

    const updated = db.taskGet("T-102")!;
    expect(updated.retry_count).toBe(1);
    expect(updated.status).toBe("active");
  });

  test("plan step failure with retries exhausted fails the task", () => {
    createTaskAt("T-103", "plan", 0, { retry_count: 2, max_retries: 2 });

    onStepComplete("T-103", "failure");

    const updated = db.taskGet("T-103")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");

    // Verify retry_exhausted event was logged
    const events = db.eventsByTask("T-103");
    const exhausted = events.find(e => e.event_type === "retry_exhausted");
    expect(exhausted).toBeDefined();
  });

  test("evaluate step failure transitions to implement (step-id, not $fail)", () => {
    createTaskAt("T-104", "evaluate", 2);

    onStepComplete("T-104", "failure");

    const updated = db.taskGet("T-104")!;
    // evaluate's on_failure = "implement", so it loops back
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
    expect(updated.status).toBe("active");
  });

  test("task with nonexistent path_name fails the task", () => {
    createTaskAt("T-105", "plan", 0, { path_name: "nonexistent" });

    onStepComplete("T-105", "success");

    const updated = db.taskGet("T-105")!;
    expect(updated.status).toBe("failed");
  });

  test("task with nonexistent current_step fails the task", () => {
    createTaskAt("T-106", "bogus_step", 0);

    onStepComplete("T-106", "success");

    const updated = db.taskGet("T-106")!;
    expect(updated.status).toBe("failed");
  });

  test("fatal outcome fails the task immediately, bypassing on_failure routing", () => {
    createTaskAt("T-107", "evaluate", 2);

    onStepComplete("T-107", "fatal", "Rebase conflict loop — needs manual resolution");

    const updated = db.taskGet("T-107")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");

    // Verify event was logged with the context
    const events = db.eventsByTask("T-107");
    const failEvent = events.find(e => e.event_type === "task_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.summary).toContain("Rebase conflict loop");
  });

  test("fatal outcome does not retry even when retries are available", () => {
    createTaskAt("T-108", "evaluate", 2, { retry_count: 0, max_retries: 5 });

    onStepComplete("T-108", "fatal", "Unrecoverable failure");

    const updated = db.taskGet("T-108")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");
    // retry_count should NOT be incremented
    expect(updated.retry_count).toBe(0);
  });
});
