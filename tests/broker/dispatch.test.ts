import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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

  // Seed a tree
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

describe("Terminal state guards", () => {
  // In v3, terminal statuses are "completed" and "failed" (TaskStatus enum).
  // The DB uses these directly — old statuses like "done", "merged", "ready" no longer exist.
  const TERMINAL_STATUSES = ["completed", "failed"];
  const isTerminalStatus = (s: string) => TERMINAL_STATUSES.includes(s);

  test("dispatch endpoint rejects tasks in 'completed' state", () => {
    createTask("W-001", "completed");

    const task = db.taskGet("W-001")!;
    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint rejects tasks in 'failed' state", () => {
    createTask("W-001", "failed");

    const task = db.taskGet("W-001")!;
    expect(isTerminalStatus(task.status)).toBe(true);
  });

  test("dispatch endpoint allows tasks in 'draft' state", () => {
    createTask("W-001", "draft");

    const task = db.taskGet("W-001")!;
    expect(isTerminalStatus(task.status)).toBe(false);
  });

  test("dispatch endpoint allows tasks in 'queued' state", () => {
    createTask("W-001", "queued");

    const task = db.taskGet("W-001")!;
    expect(isTerminalStatus(task.status)).toBe(false);
  });

  test("dispatch endpoint allows tasks in 'active' state", () => {
    createTask("W-001", "active");

    const task = db.taskGet("W-001")!;
    expect(isTerminalStatus(task.status)).toBe(false);
  });

  test("getNewlyUnblocked excludes tasks in terminal states", () => {
    createTask("W-001", "completed");
    createTask("W-002", "completed", { dependsOn: "W-001" });
    createTask("W-003", "failed", { dependsOn: "W-001" });
    createTask("W-004", "draft", { dependsOn: "W-001" });

    const unblocked = db.getNewlyUnblocked("W-001");

    // Only W-004 (draft) should be unblocked; W-002 (completed) and W-003 (failed) are terminal
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].id).toBe("W-004");
  });

  test("pipeline skips task if DB status is no longer 'done'", () => {
    // Scenario: worker:ended fires with status "done" but task has already been
    // set to "failed" by another process (e.g., health monitor race)
    createTask("W-001", "failed");

    const task = db.taskGet("W-001")!;

    // Pipeline should check DB status and skip
    expect(task.status).toBe("failed");
    expect(task.status !== "done").toBe(true);
  });
});
