import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

let db: Database;
let cleanup: () => void;

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  db.treeUpsert({
    id: "my-app",
    name: "my-app",
    path: "/tmp/my-app",
    github: "owner/my-app",
    branch_prefix: "grove/",
  });
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Schema: skill_overrides column
// ---------------------------------------------------------------------------

describe("skill_overrides column", () => {
  test("column exists after migration", () => {
    const cols = db.all<{ name: string }>("PRAGMA table_info(tasks)");
    expect(cols.some(c => c.name === "skill_overrides")).toBe(true);
  });

  test("defaults to null", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'draft')",
      [taskId, "my-app", "No overrides"],
    );
    const task = db.taskGet(taskId);
    expect(task!.skill_overrides).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CRUD: create + update with skill_overrides
// ---------------------------------------------------------------------------

describe("skill_overrides CRUD", () => {
  test("task can be created with skill_overrides", () => {
    const taskId = db.nextTaskId("W");
    const overrides = JSON.stringify({ implement: ["tdd", "code-review"] });
    db.run(
      "INSERT INTO tasks (id, tree_id, title, skill_overrides, status) VALUES (?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Custom skills", overrides],
    );
    const task = db.taskGet(taskId);
    expect(task!.skill_overrides).toBe(overrides);
    const parsed = JSON.parse(task!.skill_overrides!);
    expect(parsed.implement).toEqual(["tdd", "code-review"]);
  });

  test("skill_overrides can be updated on a draft task", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'draft')",
      [taskId, "my-app", "Will override"],
    );

    const overrides = JSON.stringify({ review: ["adversarial-review"] });
    db.run("UPDATE tasks SET skill_overrides = ? WHERE id = ?", [overrides, taskId]);

    const task = db.taskGet(taskId);
    expect(task!.skill_overrides).toBe(overrides);
  });

  test("skill_overrides can be cleared back to null", () => {
    const taskId = db.nextTaskId("W");
    const overrides = JSON.stringify({ review: ["adversarial-review"] });
    db.run(
      "INSERT INTO tasks (id, tree_id, title, skill_overrides, status) VALUES (?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Will clear", overrides],
    );

    db.run("UPDATE tasks SET skill_overrides = NULL WHERE id = ?", [taskId]);
    const task = db.taskGet(taskId);
    expect(task!.skill_overrides).toBeNull();
  });

  test("multiple steps can have overrides", () => {
    const taskId = db.nextTaskId("W");
    const overrides = JSON.stringify({
      implement: ["tdd"],
      review: ["adversarial-review", "security-review"],
      merge: ["merge-handler"],
    });
    db.run(
      "INSERT INTO tasks (id, tree_id, title, skill_overrides, status) VALUES (?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Multi-step overrides", overrides],
    );

    const task = db.taskGet(taskId);
    const parsed = JSON.parse(task!.skill_overrides!);
    expect(Object.keys(parsed)).toHaveLength(3);
    expect(parsed.review).toEqual(["adversarial-review", "security-review"]);
  });
});

// ---------------------------------------------------------------------------
// PATCH field allowlist: skill_overrides included for draft tasks
// ---------------------------------------------------------------------------

describe("PATCH allowlist", () => {
  test("draft task allows skill_overrides in draftFields", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'draft')",
      [taskId, "my-app", "Draft task"],
    );

    const draftFields = ["title", "description", "tree_id", "path_name", "priority", "depends_on", "parent_task_id", "max_retries", "github_issue", "labels", "skill_overrides"];
    const body: Record<string, unknown> = {
      skill_overrides: JSON.stringify({ implement: ["tdd"] }),
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const field of draftFields) {
      if (field in body) {
        sets.push(`${field} = ?`);
        vals.push(body[field] ?? null);
      }
    }
    vals.push(taskId);
    db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);

    const task = db.taskGet(taskId);
    expect(task!.skill_overrides).toBe(JSON.stringify({ implement: ["tdd"] }));
  });

  test("non-draft task does not allow skill_overrides", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'active')",
      [taskId, "my-app", "Active task"],
    );

    // Simulate limited fields (non-draft) — skill_overrides not in limited
    const limitedFields = ["title", "description"];
    const body: Record<string, unknown> = {
      skill_overrides: JSON.stringify({ implement: ["tdd"] }),
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const field of limitedFields) {
      if (field in body) {
        sets.push(`${field} = ?`);
        vals.push(body[field] ?? null);
      }
    }

    // No fields matched — skill_overrides was blocked
    expect(sets.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Worker override resolution logic
// ---------------------------------------------------------------------------

describe("worker skill override resolution", () => {
  test("overrides replace step defaults for matching step", () => {
    const taskOverrides = JSON.stringify({ review: ["adversarial-review"] });
    const stepSkills = ["code-review"];
    const stepId = "review";

    const overrides: Record<string, string[]> = JSON.parse(taskOverrides);
    const effective = overrides[stepId] ?? stepSkills;

    expect(effective).toEqual(["adversarial-review"]);
  });

  test("falls back to step defaults when no override for step", () => {
    const taskOverrides = JSON.stringify({ review: ["adversarial-review"] });
    const stepSkills = ["feature-dev"];
    const stepId = "implement";

    const overrides: Record<string, string[]> = JSON.parse(taskOverrides);
    const effective = overrides[stepId] ?? stepSkills;

    expect(effective).toEqual(["feature-dev"]);
  });

  test("falls back to step defaults when task has no overrides", () => {
    const taskOverrides: string | null = null;
    const stepSkills = ["code-review"];
    const stepId = "review";

    const overrides: Record<string, string[]> | null =
      taskOverrides ? JSON.parse(taskOverrides) : null;
    const effective = (overrides && overrides[stepId]) ?? stepSkills;

    expect(effective).toEqual(["code-review"]);
  });

  test("override can set empty skills array for a step", () => {
    const taskOverrides = JSON.stringify({ merge: [] });
    const stepSkills = ["merge-handler"];
    const stepId = "merge";

    const overrides: Record<string, string[]> = JSON.parse(taskOverrides);
    const effective = overrides[stepId] ?? stepSkills;

    expect(effective).toEqual([]);
  });

  test("override can add skills to a step that had none", () => {
    const taskOverrides = JSON.stringify({ implement: ["tdd", "domain-expert"] });
    const stepSkills: string[] | undefined = undefined;
    const stepId = "implement";

    const overrides: Record<string, string[]> = JSON.parse(taskOverrides);
    const effective = overrides[stepId] ?? stepSkills ?? [];

    expect(effective).toEqual(["tdd", "domain-expert"]);
  });
});
