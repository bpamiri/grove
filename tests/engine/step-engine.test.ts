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

  test("string step 'merge' infers worker type", () => {
    const result = normalizePath({ description: "test", steps: ["merge"] });
    expect(result.steps[0].type).toBe("worker");
  });

  test("string step 'evaluate' infers worker type", () => {
    const result = normalizePath({ description: "test", steps: ["evaluate"] });
    expect(result.steps[0].type).toBe("worker");
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

  test("read-only step on_failure defaults to nearest preceding read-write worker", () => {
    const result = normalizePath({
      description: "test",
      steps: [
        { id: "implement", type: "worker" },
        { id: "review", type: "worker", sandbox: "read-only" },
        { id: "merge", type: "worker" },
      ],
    });
    expect(result.steps[1].on_failure).toBe("implement");
  });

  test("read-only step with no preceding read-write worker defaults on_failure to $fail", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "review", type: "worker", sandbox: "read-only" }],
    });
    expect(result.steps[0].on_failure).toBe("$fail");
  });

  test("all string steps infer worker type", () => {
    const result = normalizePath({ description: "test", steps: ["review"] });
    expect(result.steps[0].type).toBe("worker");
  });

  test("adversarial path normalizes correctly", () => {
    const result = normalizePath({
      description: "adversarial",
      steps: [
        { plan: { type: "worker", prompt: "Create plan" } },
        { review: { type: "worker", sandbox: "read-only", prompt: "Critique plan", on_failure: "plan", max_retries: 3 } },
        "implement",
        "evaluate",
        "merge",
      ],
    });
    expect(result.steps.length).toBe(5);
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[1].type).toBe("worker");
    expect(result.steps[1].sandbox).toBe("read-only");
    expect(result.steps[1].on_failure).toBe("plan");
    expect(result.steps[1].max_retries).toBe(3);
    expect(result.steps[2].type).toBe("worker");
    expect(result.steps[3].type).toBe("worker");
    expect(result.steps[4].type).toBe("worker");
  });

  test("multi-step path wires full chain correctly", () => {
    const result = normalizePath({
      description: "dev",
      steps: [
        { plan: { type: "worker", prompt: "Plan" } },
        { implement: { type: "worker", prompt: "Build" } },
        { review: { type: "worker", sandbox: "read-only", on_failure: "implement" } },
        "merge",
      ],
    });
    expect(result.steps.length).toBe(4);
    expect(result.steps[0].on_success).toBe("implement");
    expect(result.steps[1].on_success).toBe("review");
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
      { id: "implement", type: "worker" as const, on_success: "review", on_failure: "$fail", label: "Implement" },
      { id: "review", type: "worker" as const, sandbox: "read-only" as const, on_success: "merge", on_failure: "implement", label: "Review", max_retries: 2 },
      { id: "merge", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Merge" },
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
// Also add adversarial path for review step tests
(TEST_PATHS as any).adversarial = {
  description: "Adversarial planning with review loop",
  steps: [
    { id: "plan", type: "worker" as const, on_success: "review", on_failure: "$fail", label: "Plan" },
    { id: "review", type: "worker" as const, sandbox: "read-only" as const, on_success: "implement", on_failure: "plan", label: "Review", max_retries: 3 },
    { id: "implement", type: "worker" as const, on_success: "code-review", on_failure: "$fail", label: "Implement" },
    { id: "code-review", type: "worker" as const, sandbox: "read-only" as const, on_success: "merge", on_failure: "implement", label: "Code Review" },
    { id: "merge", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Merge" },
  ],
};

const _realConfig = await import("../../src/broker/config");
const _realWorker = await import("../../src/agents/worker");
const _realWorktree = await import("../../src/shared/worktree");

// Track rebaseOnMain calls for assertions
let mockRebaseResult: { ok: boolean; conflictFiles?: string[]; error?: string } = { ok: true };
const rebaseOnMainMock = mock(() => mockRebaseResult);

// Control rebase_before_eval setting per-test
let mockRebaseBeforeEval = true;

// config: override configNormalizedPaths + settingsGet, preserve all other config functions
mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => TEST_PATHS,
  settingsGet: (key: string) => {
    if (key === "rebase_before_eval") return mockRebaseBeforeEval;
    return (_realConfig as any).settingsGet(key);
  },
}));

// worker: override spawnWorker to prevent spawning Claude Code processes
mock.module("../../src/agents/worker", () => ({
  ..._realWorker,
  spawnWorker: mock(() => {}),
}));

// worktree: override rebaseOnMain to control rebase behavior in tests
mock.module("../../src/shared/worktree", () => ({
  ..._realWorktree,
  rebaseOnMain: rebaseOnMainMock,
}));

// Dynamic import AFTER mocks are set up
const { startPipeline, onStepComplete, resumePipeline, _setDb } = await import("../../src/engine/step-engine");

describe("startPipeline", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
  });

  afterEach(async () => {
    bus.removeAll();
    // Flush pending microtasks (async executeStep from startPipeline) before closing DB
    await new Promise((r) => setTimeout(r, 10));
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

    // Set module-level _db without side effects (no bus handlers, no async imports).
    _setDb(db);
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
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

  test("last step success ($done) completes the task", () => {
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

  test("review step failure transitions to implement (step-id, not $fail)", () => {
    createTaskAt("T-104", "review", 2);

    onStepComplete("T-104", "failure");

    const updated = db.taskGet("T-104")!;
    // review's on_failure = "implement", so it loops back
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
    createTaskAt("T-107", "review", 2);

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
    createTaskAt("T-108", "review", 2, { retry_count: 0, max_retries: 5 });

    onStepComplete("T-108", "fatal", "Unrecoverable failure");

    const updated = db.taskGet("T-108")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");
    // retry_count should NOT be incremented
    expect(updated.retry_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resumePipeline tests
// ---------------------------------------------------------------------------

describe("resumePipeline", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
    // No need to call startPipeline here — resumePipeline sets _db itself.
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  function createTaskAt(id: string, step: string, stepIndex: number, opts: { retry_count?: number; max_retries?: number; status?: string } = {}) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, retry_count, max_retries)
       VALUES (?, ?, ?, 'tree-1', 'development', ?, ?, ?, ?)`,
      [
        id,
        `Task ${id}`,
        opts.status ?? "failed",
        step,
        stepIndex,
        opts.retry_count ?? 1,
        opts.max_retries ?? 2,
      ],
    );
  }

  test("resumes at task's current_step when no stepId provided", () => {
    createTaskAt("T-200", "review", 2);
    const task = db.taskGet("T-200")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db);

    expect(result.ok).toBe(true);
    const updated = db.taskGet("T-200")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("review");
    expect(updated.step_index).toBe(2);
    expect(updated.retry_count).toBe(0);
  });

  test("resumes at explicit stepId", () => {
    createTaskAt("T-201", "review", 2);
    const task = db.taskGet("T-201")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db, "implement");

    expect(result.ok).toBe(true);
    const updated = db.taskGet("T-201")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
    expect(updated.retry_count).toBe(0);
  });

  test("rejects invalid stepId", () => {
    createTaskAt("T-202", "review", 2);
    const task = db.taskGet("T-202")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db, "nonexistent");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
    // Task should not be modified
    const updated = db.taskGet("T-202")!;
    expect(updated.status).toBe("failed");
  });

  test("rejects when current_step is $done", () => {
    createTaskAt("T-203", "$done", 3, { status: "completed" });
    const task = db.taskGet("T-203")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("$done");
  });

  test("rejects when current_step is null", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step) VALUES (?, ?, 'draft', 'tree-1', 'development', NULL)",
      ["T-204", "Task T-204"],
    );
    const task = db.taskGet("T-204")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no current step");
  });

  test("resets retry_count to 0", () => {
    createTaskAt("T-205", "implement", 1, { retry_count: 3 });
    const task = db.taskGet("T-205")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db);

    const updated = db.taskGet("T-205")!;
    expect(updated.retry_count).toBe(0);
  });

  test("rejects when path config not found", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index) VALUES (?, ?, 'failed', 'tree-1', 'nonexistent', 'plan', 0)",
      ["T-206", "Task T-206"],
    );
    const task = db.taskGet("T-206")!;
    const tree = db.treeGet("tree-1")!;

    const result = resumePipeline(task, tree, db);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  test("emits task:status event", () => {
    createTaskAt("T-207", "review", 2);
    const task = db.taskGet("T-207")!;
    const tree = db.treeGet("tree-1")!;

    const statuses: string[] = [];
    bus.on("task:status", ({ status }) => statuses.push(status));

    resumePipeline(task, tree, db);

    expect(statuses).toContain("active");
  });

  test("logs step_resumed event", () => {
    createTaskAt("T-208", "review", 2);
    const task = db.taskGet("T-208")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "implement");

    const events = db.eventsByTask("T-208");
    const resumed = events.find(e => e.event_type === "step_resumed");
    expect(resumed).toBeDefined();
    expect(resumed!.summary).toContain("implement");
  });
});

// ---------------------------------------------------------------------------
// Review step pipeline tests (adversarial path)
// ---------------------------------------------------------------------------

describe("review step transitions", () => {
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

  function createTaskAt(id: string, step: string, stepIndex: number, opts: { retry_count?: number; max_retries?: number; path_name?: string } = {}) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, retry_count, max_retries)
       VALUES (?, ?, 'active', 'tree-1', ?, ?, ?, ?, ?)`,
      [
        id,
        `Task ${id}`,
        opts.path_name ?? "adversarial",
        step,
        stepIndex,
        opts.retry_count ?? 0,
        opts.max_retries ?? 2,
      ],
    );
  }

  test("plan step success transitions to review", () => {
    createTaskAt("T-300", "plan", 0);

    onStepComplete("T-300", "success");

    const updated = db.taskGet("T-300")!;
    expect(updated.current_step).toBe("review");
    expect(updated.step_index).toBe(1);
    expect(updated.status).toBe("active");
  });

  test("review step success transitions to implement", () => {
    createTaskAt("T-301", "review", 1);

    onStepComplete("T-301", "success");

    const updated = db.taskGet("T-301")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(2);
    expect(updated.status).toBe("active");
  });

  test("review step failure transitions back to plan (on_failure: plan)", () => {
    createTaskAt("T-302", "review", 1);

    onStepComplete("T-302", "failure");

    const updated = db.taskGet("T-302")!;
    // review's on_failure = "plan", so it loops back
    expect(updated.current_step).toBe("plan");
    expect(updated.step_index).toBe(0);
    expect(updated.status).toBe("active");
  });

  test("review step fatal outcome fails the task immediately", () => {
    createTaskAt("T-303", "review", 1);

    onStepComplete("T-303", "fatal", "Review loop exhausted — plan not approved");

    const updated = db.taskGet("T-303")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");

    const events = db.eventsByTask("T-303");
    const failEvent = events.find(e => e.event_type === "task_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.summary).toContain("plan not approved");
  });

  test("review failure loops plan→review→plan correctly", () => {
    createTaskAt("T-304", "plan", 0);

    // plan succeeds → transitions to review
    onStepComplete("T-304", "success");
    let updated = db.taskGet("T-304")!;
    expect(updated.current_step).toBe("review");

    // review fails → transitions back to plan
    onStepComplete("T-304", "failure");
    updated = db.taskGet("T-304")!;
    expect(updated.current_step).toBe("plan");

    // plan succeeds again → transitions to review
    onStepComplete("T-304", "success");
    updated = db.taskGet("T-304")!;
    expect(updated.current_step).toBe("review");

    // review succeeds → transitions to implement
    onStepComplete("T-304", "success");
    updated = db.taskGet("T-304")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(2);
  });

  test("startPipeline begins adversarial path at plan step", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name) VALUES (?, ?, 'draft', 'tree-1', 'adversarial')",
      ["T-305", "Task T-305"],
    );
    const task = db.taskGet("T-305")!;
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("T-305")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("plan");
    expect(updated.step_index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rebase before eval tests (W-078)
// ---------------------------------------------------------------------------

describe("rebase before eval", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
    _setDb(db);
    rebaseOnMainMock.mockClear();
    mockRebaseResult = { ok: true };
    mockRebaseBeforeEval = true;
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  function createTaskAt(
    id: string,
    step: string,
    stepIndex: number,
    opts: { worktree_path?: string; path_name?: string } = {},
  ) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, worktree_path)
       VALUES (?, ?, 'active', 'tree-1', ?, ?, ?, ?)`,
      [
        id,
        `Task ${id}`,
        opts.path_name ?? "development",
        step,
        stepIndex,
        opts.worktree_path ?? "/tmp/test-tree/.grove/worktrees/" + id,
      ],
    );
  }

  test("calls rebaseOnMain before read-only step", async () => {
    createTaskAt("T-400", "review", 2);
    const task = db.taskGet("T-400")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).toHaveBeenCalled();

    // Verify rebase_completed event was logged
    const events = db.eventsByTask("T-400");
    const rebaseEvent = events.find((e) => e.event_type === "rebase_completed");
    expect(rebaseEvent).toBeDefined();
  });

  test("does not call rebaseOnMain for read-write steps", async () => {
    createTaskAt("T-401", "plan", 0);
    const task = db.taskGet("T-401")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "plan");
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });

  test("does not call rebaseOnMain when setting is disabled", async () => {
    mockRebaseBeforeEval = false;
    createTaskAt("T-402", "review", 2);
    const task = db.taskGet("T-402")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });

  test("rebase conflict fails the step with context", async () => {
    mockRebaseResult = {
      ok: false,
      conflictFiles: ["src/index.ts", "package.json"],
      error: "rebase conflict with origin/main",
    };
    createTaskAt("T-403", "review", 2);
    const task = db.taskGet("T-403")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    // Should have logged a rebase_conflict event
    const events = db.eventsByTask("T-403");
    const conflictEvent = events.find((e) => e.event_type === "rebase_conflict");
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.summary).toContain("src/index.ts");
    expect(conflictEvent!.summary).toContain("package.json");

    // The step should have failed, transitioning back to implement (review's on_failure)
    const updated = db.taskGet("T-403")!;
    expect(updated.current_step).toBe("implement");
  });

  test("does not call rebaseOnMain when worktree_path is null", async () => {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, worktree_path)
       VALUES (?, ?, 'active', 'tree-1', 'development', 'review', 2, NULL)`,
      ["T-404", "Task T-404"],
    );
    const task = db.taskGet("T-404")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });
});
