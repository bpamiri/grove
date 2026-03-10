// Tests for the status command
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");
const projectRoot = join(import.meta.dir, "../..");

let tempDir: string;
let db: Database;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-status-test-"));
  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;

  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  writeFileSync(
    join(tempDir, "grove.yaml"),
    `
workspace:
  name: "Test Workshop"
repos:
  wheels:
    org: cfwheels
    github: cfwheels/wheels
    path: ~/code/wheels
budgets:
  per_task: 5
  per_session: 10
  per_day: 25
  per_week: 100
  auto_approve_under: 2
settings:
  max_concurrent: 4
  branch_prefix: "grove/"
  auto_sync: false
`,
  );
});

afterEach(() => {
  db.close();

  if (originalEnv.GROVE_HOME !== undefined) process.env.GROVE_HOME = originalEnv.GROVE_HOME;
  else delete process.env.GROVE_HOME;
  if (originalEnv.GROVE_ROOT !== undefined) process.env.GROVE_ROOT = originalEnv.GROVE_ROOT;
  else delete process.env.GROVE_ROOT;

  rmSync(tempDir, { recursive: true, force: true });
});

async function resetModules() {
  const { closeDb } = await import("../../src/core/db");
  closeDb();
  const config = await import("../../src/core/config");
  config.reloadConfig();
}

describe("statusCommand", () => {
  test("runs without error when no tasks exist", async () => {
    await resetModules();
    const { statusCommand } = await import("../../src/commands/status");
    // Should not throw
    await statusCommand.run([]);
  });

  test("runs without error with tasks in various states", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-001", "manual", "Ingested task", "ingested"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-002", "manual", "Running task", "running"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-003", "manual", "Paused task", "paused"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-004", "manual", "Ready task", "ready"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-005", "manual", "Done task", "completed"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-006", "manual", "Failed task", "failed"]);

    await resetModules();
    const { statusCommand } = await import("../../src/commands/status");
    await statusCommand.run([]);
  });

  test("DB state matches expected counts", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-001", "manual", "A", "running"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-002", "manual", "B", "running"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-003", "manual", "C", "ready"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-004", "manual", "D", "paused"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-005", "manual", "E", "completed"]);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.taskCount()).toBe(5);
    expect(testDb.taskCount("running")).toBe(2);
    expect(testDb.taskCount("ready")).toBe(1);
    expect(testDb.taskCount("paused")).toBe(1);
    expect(testDb.taskCount("completed")).toBe(1);
  });

  test("recent events appear", async () => {
    db.addEvent(null, "created", "Grove initialized");
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-001", "manual", "Test", "running"]);
    db.addEvent("W-001", "started", "Task W-001 started");

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const events = testDb.recentEvents(5);
    expect(events.length).toBe(2);
    expect(events[0].summary).toContain("W-001 started");
  });

  test("budget info available", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-001", "manual", "A", "done"]);
    db.exec("INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)", ["W-001", 5.0]);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.costToday()).toBe(5.0);
    expect(testDb.costWeek()).toBeGreaterThanOrEqual(5.0);
  });
});
