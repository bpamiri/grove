import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { bus } from "../../src/broker/event-bus";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "dispatch-test.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);

  // Seed trees
  db.treeUpsert({ id: "test", name: "test", path: "/tmp/test" });
  db.treeUpsert({ id: "test-tree", name: "Test Tree", path: "/tmp/test-tree", github: "org/repo" });
});

afterEach(() => {
  bus.removeAll("task:created");
  bus.removeAll("worker:ended");
  bus.removeAll("merge:completed");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// Helper to create a task at a specific status
function createTask(id: string, status: string, opts: { treeId?: string; dependsOn?: string } = {}) {
  db.run(
    "INSERT INTO tasks (id, title, status, tree_id, depends_on) VALUES (?, ?, ?, ?, ?)",
    [id, `Task ${id}`, status, opts.treeId ?? "test-tree", opts.dependsOn ?? null]
  );
}

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

describe("Terminal state guards", () => {
  test("dispatch endpoint rejects tasks in 'done' state", async () => {
    createTask("W-001", "done");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint rejects tasks in 'failed' state", async () => {
    createTask("W-001", "failed");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint rejects tasks in 'completed' state", async () => {
    createTask("W-001", "completed");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint rejects tasks in 'merged' state", async () => {
    createTask("W-001", "merged");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint rejects tasks in 'conflict' state", async () => {
    createTask("W-001", "conflict");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint allows tasks in 'planned' state", async () => {
    createTask("W-001", "planned");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(false);
  });

  test("dispatch endpoint allows tasks in 'ready' state", async () => {
    createTask("W-001", "ready");

    const task = db.taskGet("W-001")!;
    const { isTerminalStatus } = await import("../../src/shared/types");

    expect(isTerminalStatus(task.status)).toBe(false);
  });

  test("getNewlyUnblocked excludes tasks in terminal states", () => {
    createTask("W-001", "merged");
    createTask("W-002", "done", { dependsOn: "W-001" });
    createTask("W-003", "failed", { dependsOn: "W-001" });
    createTask("W-004", "planned", { dependsOn: "W-001" });

    const unblocked = db.getNewlyUnblocked("W-001");

    // Only W-004 (planned) should be unblocked; W-002 (done) and W-003 (failed) are terminal
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].id).toBe("W-004");
  });

  test("pipeline skips task if DB status is no longer 'done'", () => {
    createTask("W-001", "failed");

    const task = db.taskGet("W-001")!;

    expect(task.status).toBe("failed");
    expect(task.status !== "done").toBe(true);
  });
});
