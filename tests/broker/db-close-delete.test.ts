import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-close-delete.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

describe("Close task (soft close via status)", () => {
  test("close a draft task", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Draft task", "draft"]);
    db.taskSetStatus("W-001", "closed");
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("closed");
  });

  test("close a failed task", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Failed task", "failed"]);
    db.taskSetStatus("W-001", "closed");
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("closed");
  });

  test("closed tasks are excluded from getNewlyUnblocked", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Blocker", "completed"]);
    db.run("INSERT INTO tasks (id, title, status, depends_on) VALUES (?, ?, ?, ?)", ["W-002", "Blocked", "closed", "W-001"]);
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(0);
  });

  test("closed task creates status_change event", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Task", "draft"]);
    db.taskSetStatus("W-001", "closed");
    const events = db.eventsByTask("W-001");
    expect(events.length).toBe(1);
    expect(events[0].summary).toContain("closed");
  });
});

describe("Delete task (hard delete)", () => {
  test("delete an existing task", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Draft", "draft"]);
    const deleted = db.taskDelete("W-001");
    expect(deleted).toBe(true);
    expect(db.taskGet("W-001")).toBeNull();
  });

  test("delete nonexistent task returns false", () => {
    const deleted = db.taskDelete("W-999");
    expect(deleted).toBe(false);
  });

  test("delete does not affect other tasks", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Delete me", "draft"]);
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-002", "Keep me", "draft"]);
    db.taskDelete("W-001");
    expect(db.taskGet("W-001")).toBeNull();
    expect(db.taskGet("W-002")).not.toBeNull();
  });
});
