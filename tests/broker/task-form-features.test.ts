import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

describe("labels column", () => {
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

  test("labels column exists after migration", () => {
    const cols = db.all<{ name: string }>("PRAGMA table_info(tasks)");
    expect(cols.some(c => c.name === "labels")).toBe(true);
  });

  test("task can be created with labels", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, labels, status) VALUES (?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Labeled task", "bug,enhancement"],
    );
    const task = db.taskGet(taskId);
    expect(task!.labels).toBe("bug,enhancement");
  });

  test("labels default to null", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'draft')",
      [taskId, "my-app", "No labels"],
    );
    const task = db.taskGet(taskId);
    expect(task!.labels).toBeNull();
  });

  test("labels can be updated", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, labels, status) VALUES (?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Task", "bug"],
    );
    db.run("UPDATE tasks SET labels = ? WHERE id = ?", ["bug,priority", taskId]);
    const task = db.taskGet(taskId);
    expect(task!.labels).toBe("bug,priority");
  });
});

describe("PATCH task fields", () => {
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

  test("draft task allows all editable fields including labels", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, 'draft')",
      [taskId, "my-app", "Original title"],
    );

    const draftFields = ["title", "description", "tree_id", "path_name", "priority", "depends_on", "parent_task_id", "max_retries", "github_issue", "labels"];
    const updates: Record<string, unknown> = {
      title: "Updated title",
      description: "New description",
      path_name: "research",
      priority: 2,
      labels: "bug,urgent",
      max_retries: 5,
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const field of draftFields) {
      if (field in updates) {
        sets.push(`${field} = ?`);
        vals.push(updates[field] ?? null);
      }
    }
    vals.push(taskId);
    db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);

    const task = db.taskGet(taskId);
    expect(task!.title).toBe("Updated title");
    expect(task!.description).toBe("New description");
    expect(task!.path_name).toBe("research");
    expect(task!.priority).toBe(2);
    expect(task!.labels).toBe("bug,urgent");
    expect(task!.max_retries).toBe(5);
  });

  test("non-draft task only allows title and description", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, labels, priority) VALUES (?, ?, ?, 'active', ?, ?)",
      [taskId, "my-app", "Active task", "bug", 1],
    );

    // Simulate PATCH with limited fields
    const limitedFields = ["title", "description"];
    const body: Record<string, unknown> = {
      title: "New title",
      labels: "should-not-change", // not in limitedFields
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const field of limitedFields) {
      if (field in body) {
        sets.push(`${field} = ?`);
        vals.push(body[field] ?? null);
      }
    }
    vals.push(taskId);
    db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);

    const task = db.taskGet(taskId);
    expect(task!.title).toBe("New title");
    expect(task!.labels).toBe("bug"); // unchanged
    expect(task!.priority).toBe(1); // unchanged
  });
});

describe("buildDepChain", () => {
  // Pure function test — import directly
  // The function is in TaskForm.tsx (frontend), so we test the logic inline

  function buildDepChain(selected: string[], allTasks: Array<{ id: string; depends_on: string | null }>): string[][] {
    const taskMap = new Map(allTasks.map(t => [t.id, t]));
    const chains: string[][] = [];

    for (const id of selected) {
      const chain: string[] = [];
      const visited = new Set<string>();
      let current = id;
      while (current && !visited.has(current)) {
        visited.add(current);
        chain.unshift(current);
        const task = taskMap.get(current);
        const deps = task?.depends_on?.split(",").map(d => d.trim()).filter(Boolean) ?? [];
        current = deps[0] ?? "";
      }
      if (chain.length > 1) chains.push(chain);
    }
    return chains;
  }

  test("returns empty for tasks with no transitive deps", () => {
    const tasks = [
      { id: "W-001", depends_on: null },
      { id: "W-002", depends_on: null },
    ];
    expect(buildDepChain(["W-001"], tasks)).toEqual([]);
  });

  test("builds simple chain", () => {
    const tasks = [
      { id: "W-001", depends_on: null },
      { id: "W-002", depends_on: "W-001" },
      { id: "W-003", depends_on: "W-002" },
    ];
    expect(buildDepChain(["W-003"], tasks)).toEqual([["W-001", "W-002", "W-003"]]);
  });

  test("builds chain for multiple selected deps", () => {
    const tasks = [
      { id: "W-001", depends_on: null },
      { id: "W-002", depends_on: "W-001" },
      { id: "W-003", depends_on: null },
    ];
    const chains = buildDepChain(["W-002", "W-003"], tasks);
    expect(chains).toEqual([["W-001", "W-002"]]);
    // W-003 has no deps beyond itself, so chain length is 1 → excluded
  });

  test("handles circular dependencies without infinite loop", () => {
    const tasks = [
      { id: "W-001", depends_on: "W-002" },
      { id: "W-002", depends_on: "W-001" },
    ];
    const chains = buildDepChain(["W-001"], tasks);
    // Should terminate and produce a chain (not hang)
    expect(chains.length).toBe(1);
    expect(chains[0].length).toBeLessThanOrEqual(2);
  });

  test("follows first dependency when multiple exist", () => {
    const tasks = [
      { id: "W-001", depends_on: null },
      { id: "W-002", depends_on: null },
      { id: "W-003", depends_on: "W-001,W-002" },
    ];
    const chains = buildDepChain(["W-003"], tasks);
    // Should follow W-001 (first dep)
    expect(chains).toEqual([["W-001", "W-003"]]);
  });

  test("handles missing dep references gracefully", () => {
    const tasks = [
      { id: "W-003", depends_on: "W-999" }, // W-999 doesn't exist in candidates
    ];
    const chains = buildDepChain(["W-003"], tasks);
    // W-999 is still shown in the chain (unknown dep) — the walk stops there
    expect(chains).toEqual([["W-999", "W-003"]]);
  });
});
