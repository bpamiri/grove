// Grove v3 — Step engine unit tests: path normalization and DB state transitions
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { normalizeAllPaths } from "../../src/engine/normalize";
import { DEFAULT_PATHS } from "../../src/shared/types";
import type { Database } from "../../src/broker/db";

// ---------------------------------------------------------------------------
// normalizeAllPaths
// ---------------------------------------------------------------------------

describe("normalizeAllPaths", () => {
  test("normalizes default development path — 4 steps, correct types, on_success chains, evaluate.on_failure=implement", () => {
    const result = normalizeAllPaths(DEFAULT_PATHS);
    const dev = result.development;

    expect(dev.steps).toHaveLength(4);

    const [plan, implement, evaluate, merge] = dev.steps;

    // Types
    expect(plan.type).toBe("worker");
    expect(implement.type).toBe("worker");
    expect(evaluate.type).toBe("gate");
    expect(merge.type).toBe("merge");

    // on_success chains
    expect(plan.on_success).toBe("implement");
    expect(implement.on_success).toBe("evaluate");
    expect(evaluate.on_success).toBe("merge");
    expect(merge.on_success).toBe("$done");

    // evaluate.on_failure loops back to implement
    expect(evaluate.on_failure).toBe("implement");
  });

  test("normalizes research path — 3 steps, last step on_success=$done", () => {
    const result = normalizeAllPaths(DEFAULT_PATHS);
    const research = result.research;

    expect(research.steps).toHaveLength(3);

    const last = research.steps[research.steps.length - 1];
    expect(last.on_success).toBe("$done");

    // All steps chain in order for the first two
    expect(research.steps[0].on_success).toBe("research");
    expect(research.steps[1].on_success).toBe("report");
  });

  test("infers gate type for 'evaluate' step and merge type for 'merge' step from string-only path config", () => {
    const result = normalizeAllPaths({
      simple: {
        description: "String-only steps",
        steps: ["plan", "implement", "evaluate", "merge"],
      },
    });

    const steps = result.simple.steps;
    const evaluate = steps.find(s => s.id === "evaluate");
    const merge = steps.find(s => s.id === "merge");

    expect(evaluate?.type).toBe("gate");
    expect(merge?.type).toBe("merge");
    // plan and implement default to worker
    expect(steps.find(s => s.id === "plan")?.type).toBe("worker");
    expect(steps.find(s => s.id === "implement")?.type).toBe("worker");
  });

  test("uses $fail as default on_failure", () => {
    const result = normalizeAllPaths({
      simple: {
        description: "Default on_failure",
        steps: ["plan", "implement"],
      },
    });

    for (const step of result.simple.steps) {
      expect(step.on_failure).toBe("$fail");
    }
  });
});

// ---------------------------------------------------------------------------
// Step engine DB state transitions
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("step engine DB state", () => {
  function insertTask(overrides: Record<string, unknown> = {}): string {
    const id = db.nextTaskId("W");
    db.run(
      `INSERT INTO tasks (id, tree_id, title, status, path_name, current_step, step_index, retry_count, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        overrides.tree_id ?? null,
        overrides.title ?? "Test task",
        overrides.status ?? "queued",
        overrides.path_name ?? "development",
        overrides.current_step ?? null,
        overrides.step_index ?? 0,
        overrides.retry_count ?? 0,
        overrides.max_retries ?? 2,
      ],
    );
    return id;
  }

  test("task stores current_step and step_index correctly", () => {
    const id = insertTask({ current_step: "implement", step_index: 1 });

    const task = db.taskGet(id)!;
    expect(task.current_step).toBe("implement");
    expect(task.step_index).toBe(1);
  });

  test("retry_count increments correctly", () => {
    const id = insertTask({ retry_count: 0 });

    db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [id]);
    const after1 = db.taskGet(id)!;
    expect(after1.retry_count).toBe(1);

    db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [id]);
    const after2 = db.taskGet(id)!;
    expect(after2.retry_count).toBe(2);
  });

  test("$done transition marks task completed with completed_at", () => {
    const id = insertTask({ status: "active", current_step: "merge" });

    db.run(
      "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
      [id],
    );

    const task = db.taskGet(id)!;
    expect(task.status).toBe("completed");
    expect(task.current_step).toBe("$done");
    expect(task.completed_at).not.toBeNull();
  });

  test("$fail transition marks task failed", () => {
    const id = insertTask({ status: "active", current_step: "implement" });

    db.run(
      "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
      [id],
    );

    const task = db.taskGet(id)!;
    expect(task.status).toBe("failed");
    expect(task.current_step).toBe("$fail");
  });
});
