import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.treeUpsert({ id: "test", name: "test", path: "/tmp/test" });
});

afterEach(() => {
  db.close();
});

describe("dependency checks", () => {
  test("task is blocked when dependency is not completed", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "test", "First task", "active"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "test", "Second task", "queued", "W-001"]
    );
    expect(db.isTaskBlocked("W-002")).toBe(true);
  });

  test("task is unblocked when dependency completes", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "test", "First task", "completed"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "test", "Second task", "queued", "W-001"]
    );
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("getNewlyUnblocked finds dependent tasks", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "test", "First task", "completed"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "test", "Second task", "queued", "W-001"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-003", "test", "Third task", "queued", "W-001"]
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(2);
    const ids = unblocked.map(t => t.id).sort();
    expect(ids).toEqual(["W-002", "W-003"]);
  });
});

describe("task filtering", () => {
  test("tasks without tree_id have null tree_id", () => {
    db.run(
      "INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)",
      ["W-001", "No tree task", "queued"]
    );
    const task = db.taskGet("W-001");
    expect(task).not.toBeNull();
    expect(task!.tree_id).toBeNull();
  });

  test("active and draft tasks are not returned by tasksByStatus queued", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "test", "Active task", "active"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "test", "Draft task", "draft"]
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-003", "test", "Queued task", "queued"]
    );
    const queued = db.tasksByStatus("queued");
    const ids = queued.map(t => t.id);
    expect(ids).not.toContain("W-001");
    expect(ids).not.toContain("W-002");
    expect(ids).toContain("W-003");
  });
});
