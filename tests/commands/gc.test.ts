// Tests for the gc (garbage collection) command
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");
const projectRoot = join(import.meta.dir, "../..");

let tempDir: string;
let logsDir: string;
let db: Database;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };
let originalExit: typeof process.exit;
let exited: boolean;
let errorOutput: string[];
let logOutput: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-gc-test-"));
  logsDir = join(tempDir, "logs");
  mkdirSync(logsDir);

  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;

  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  // Seed repos in DB (FK constraint requires these)
  db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: "~/code/wheels", branch_prefix: "grove/", claude_md_path: null, last_synced: null });

  // Write config
  writeFileSync(
    join(tempDir, "grove.yaml"),
    `
workspace:
  name: "Test"
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
  max_retries: 2
`,
  );

  // Mock process.exit so ui.die() doesn't kill the test runner
  originalExit = process.exit;
  exited = false;
  process.exit = (() => { exited = true; }) as any;

  // Capture console.error output
  errorOutput = [];
  const origError = console.error;
  console.error = (...args: any[]) => { errorOutput.push(args.join(" ")); };
  (globalThis as any).__origConsoleError = origError;

  // Capture console.log output
  logOutput = [];
  const origLog = console.log;
  console.log = (...args: any[]) => { logOutput.push(args.join(" ")); };
  (globalThis as any).__origConsoleLog = origLog;
});

afterEach(() => {
  db.close();

  // Restore process.exit
  process.exit = originalExit;

  // Restore console.error
  if ((globalThis as any).__origConsoleError) {
    console.error = (globalThis as any).__origConsoleError;
    delete (globalThis as any).__origConsoleError;
  }

  // Restore console.log
  if ((globalThis as any).__origConsoleLog) {
    console.log = (globalThis as any).__origConsoleLog;
    delete (globalThis as any).__origConsoleLog;
  }

  if (originalEnv.GROVE_HOME !== undefined) process.env.GROVE_HOME = originalEnv.GROVE_HOME;
  else delete process.env.GROVE_HOME;
  if (originalEnv.GROVE_ROOT !== undefined) process.env.GROVE_ROOT = originalEnv.GROVE_ROOT;
  else delete process.env.GROVE_ROOT;

  rmSync(tempDir, { recursive: true, force: true });
});

// Helper to clear the config/db module singletons
async function resetModules() {
  const { closeDb } = await import("../../src/core/db");
  closeDb();
  const config = await import("../../src/core/config");
  config.reloadConfig();
}

/** Return a SQLite datetime string N days in the past */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Insert a task with minimal boilerplate; updatedAt is a datetime string */
function insertTask(id: string, status: string, updatedAt: string, extra?: Record<string, any>) {
  const cols = ["id", "source_type", "title", "status", "repo", "updated_at"];
  const vals: any[] = [id, "manual", `Task ${id}`, status, "wheels", updatedAt];

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      cols.push(k);
      vals.push(v);
    }
  }

  const placeholders = cols.map(() => "?").join(", ");
  db.exec(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${placeholders})`, vals);
}

/** Insert an event row */
function insertEvent(taskId: string, eventType: string, summary: string, timestamp: string) {
  db.exec(
    "INSERT INTO events (task_id, event_type, summary, timestamp) VALUES (?, ?, ?, ?)",
    [taskId, eventType, summary, timestamp],
  );
}

/** Insert a session row and return its id */
function insertSession(taskId: string, status: string, startedAt: string): number {
  db.exec(
    "INSERT INTO sessions (task_id, repo, status, started_at) VALUES (?, 'wheels', ?, ?)",
    [taskId, status, startedAt],
  );
  return db.scalar<number>("SELECT last_insert_rowid()") ?? 0;
}

/** Create a log file in logsDir and set its mtime to N days ago */
function createLogFile(name: string, mtimeDaysAgo: number) {
  const filePath = join(logsDir, name);
  writeFileSync(filePath, `log content for ${name}`);
  const mtime = new Date(Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000);
  utimesSync(filePath, mtime, mtime);
}

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("gc parseDuration", () => {
  test("parse days (7d) returns cutoff ~7 days ago", async () => {
    const { parseDuration } = await import("../../src/commands/gc");
    const cutoff = parseDuration("7d");
    expect(cutoff).not.toBeNull();
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Allow 5-second tolerance
    expect(Math.abs(cutoff!.getTime() - expected)).toBeLessThan(5000);
  });

  test("parse weeks (2w) returns cutoff ~14 days ago", async () => {
    const { parseDuration } = await import("../../src/commands/gc");
    const cutoff = parseDuration("2w");
    expect(cutoff).not.toBeNull();
    const expected = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff!.getTime() - expected)).toBeLessThan(5000);
  });

  test("parse months (3m) returns cutoff ~90 days ago", async () => {
    const { parseDuration } = await import("../../src/commands/gc");
    const cutoff = parseDuration("3m");
    expect(cutoff).not.toBeNull();
    const expected = Date.now() - 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff!.getTime() - expected)).toBeLessThan(5000);
  });

  test("invalid duration returns null", async () => {
    const { parseDuration } = await import("../../src/commands/gc");
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("10x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// events cleanup
// ---------------------------------------------------------------------------

describe("gc events cleanup", () => {
  test("--events --force deletes events for terminal tasks older than 30d, preserves running", async () => {
    insertTask("W-001", "done", daysAgo(45));
    insertTask("W-002", "running", daysAgo(45));
    insertEvent("W-001", "status_change", "done", daysAgo(45));
    insertEvent("W-002", "status_change", "running", daysAgo(45));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--events", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const eventsW1 = verifyDb.all("SELECT * FROM events WHERE task_id = 'W-001'");
    const eventsW2 = verifyDb.all("SELECT * FROM events WHERE task_id = 'W-002'");
    expect(eventsW1.length).toBe(0);
    expect(eventsW2.length).toBeGreaterThan(0);
    verifyDb.close();
  });

  test("--events preserves events for done tasks newer than 30d", async () => {
    insertTask("W-001", "done", daysAgo(10));
    insertEvent("W-001", "status_change", "done", daysAgo(10));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--events", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all("SELECT * FROM events WHERE task_id = 'W-001'");
    expect(events.length).toBeGreaterThan(0);
    verifyDb.close();
  });

  test("--events --older-than 3d --force deletes ALL events for qualifying tasks", async () => {
    insertTask("W-001", "done", daysAgo(5));
    insertEvent("W-001", "status_change", "old event", daysAgo(5));
    insertEvent("W-001", "status_change", "recent event", daysAgo(1));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--events", "--older-than", "3d", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all<{ summary: string }>("SELECT * FROM events WHERE task_id = 'W-001'");
    // Task qualifies (terminal + updated_at older than 3d), so all its events are deleted
    expect(events.length).toBe(0);
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// sessions cleanup
// ---------------------------------------------------------------------------

describe("gc sessions cleanup", () => {
  test("--sessions --force deletes sessions for terminal tasks and clears task fields", async () => {
    insertTask("W-001", "done", daysAgo(45), { session_id: "42", session_summary: "old summary" });
    insertSession("W-001", "completed", daysAgo(45));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--sessions", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const sessions = verifyDb.all("SELECT * FROM sessions WHERE task_id = 'W-001'");
    expect(sessions.length).toBe(0);
    const task = verifyDb.taskGet("W-001");
    expect(task!.session_id).toBeNull();
    expect(task!.session_summary).toBeNull();
    verifyDb.close();
  });

  test("--sessions --force preserves sessions for running tasks", async () => {
    insertTask("W-001", "running", daysAgo(45));
    insertSession("W-001", "running", daysAgo(45));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--sessions", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const sessions = verifyDb.all("SELECT * FROM sessions WHERE task_id = 'W-001'");
    expect(sessions.length).toBeGreaterThan(0);
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// logs cleanup
// ---------------------------------------------------------------------------

describe("gc logs cleanup", () => {
  test("--logs --force deletes log files for terminal tasks older than 30d", async () => {
    insertTask("W-001", "done", daysAgo(45));
    createLogFile("W-001.log", 45);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--logs", "--force"]);

    expect(existsSync(join(logsDir, "W-001.log"))).toBe(false);
  });

  test("--logs --force preserves log files for running tasks", async () => {
    insertTask("W-001", "running", daysAgo(45));
    createLogFile("W-001.log", 45);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--logs", "--force"]);

    expect(existsSync(join(logsDir, "W-001.log"))).toBe(true);
  });

  test("--logs --force deletes orphaned log files older than 30d", async () => {
    // No task inserted for ORPHAN-001 -- file is orphaned
    createLogFile("ORPHAN-001.log", 45);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--logs", "--force"]);

    expect(existsSync(join(logsDir, "ORPHAN-001.log"))).toBe(false);
  });

  test("--logs --force preserves recent log files even for done tasks", async () => {
    insertTask("W-001", "done", daysAgo(5));
    createLogFile("W-001.log", 5);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--logs", "--force"]);

    expect(existsSync(join(logsDir, "W-001.log"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe("gc dry-run", () => {
  test("default (no --force) with --all: data still exists after run", async () => {
    insertTask("W-001", "done", daysAgo(45));
    insertEvent("W-001", "status_change", "done", daysAgo(45));
    insertSession("W-001", "completed", daysAgo(45));
    createLogFile("W-001.log", 45);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--all"]);

    // Everything should still exist (dry-run is the default)
    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all("SELECT * FROM events WHERE task_id = 'W-001'");
    const sessions = verifyDb.all("SELECT * FROM sessions WHERE task_id = 'W-001'");
    expect(events.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);
    expect(existsSync(join(logsDir, "W-001.log"))).toBe(true);
    verifyDb.close();
  });

  test("dry-run output includes task ID and Dry Run text", async () => {
    insertTask("W-001", "done", daysAgo(45));
    insertEvent("W-001", "status_change", "done", daysAgo(45));

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--all"]);

    const allOutput = [...logOutput, ...errorOutput].join("\n");
    expect(allOutput).toContain("W-001");
    expect(allOutput.toLowerCase()).toContain("dry");
  });
});

// ---------------------------------------------------------------------------
// --all flag
// ---------------------------------------------------------------------------

describe("gc --all flag", () => {
  test("--all --force cleans events, sessions, and log files together", async () => {
    insertTask("W-001", "done", daysAgo(45));
    insertEvent("W-001", "status_change", "done", daysAgo(45));
    insertSession("W-001", "completed", daysAgo(45));
    createLogFile("W-001.log", 45);

    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--all", "--force"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all("SELECT * FROM events WHERE task_id = 'W-001'");
    const sessions = verifyDb.all("SELECT * FROM sessions WHERE task_id = 'W-001'");
    expect(events.length).toBe(0);
    expect(sessions.length).toBe(0);
    expect(existsSync(join(logsDir, "W-001.log"))).toBe(false);
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// no category
// ---------------------------------------------------------------------------

describe("gc no category", () => {
  test("no flags shows help text", async () => {
    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run([]);

    const allOutput = [...logOutput, ...errorOutput].join("\n");
    expect(allOutput).toContain("Usage");
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe("gc validation", () => {
  test("invalid --older-than value exits with error", async () => {
    await resetModules();
    const { gcCommand } = await import("../../src/commands/gc");
    await gcCommand.run(["--events", "--older-than", "xyz"]);

    expect(exited).toBe(true);
    const allErrors = errorOutput.join("\n");
    expect(allErrors.toLowerCase()).toContain("invalid duration");
  });
});
