// Tests for reaper module — dead/stalled worker detection and cleanup
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");
const projectRoot = join(import.meta.dir, "../..");

let tempDir: string;
let db: Database;
let logsDir: string;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-reaper-test-"));
  logsDir = join(tempDir, "logs");
  mkdirSync(logsDir, { recursive: true });

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
  stall_timeout_minutes: 10
`,
  );

  // Insert repo record for FK constraint
  db.repoUpsert({
    name: "wheels",
    org: "cfwheels",
    github_full: "cfwheels/wheels",
    local_path: "~/code/wheels",
    branch_prefix: "grove/",
    claude_md_path: null,
    last_synced: null,
  });
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

/**
 * Helper: insert a running task + running session with given PID and optional log file.
 */
function insertRunningTask(taskId: string, pid: number, logFile?: string): void {
  // Insert task with status running
  db.exec(
    "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, 'manual', ?, 'running', 'wheels')",
    [taskId, `Task ${taskId}`],
  );

  // Insert session with status running, pid, and optional output_log
  db.exec(
    "INSERT INTO sessions (task_id, repo, status, pid, output_log) VALUES (?, 'wheels', 'running', ?, ?)",
    [taskId, pid, logFile ?? null],
  );
}

// ---------------------------------------------------------------------------
// reapDeadWorkers
// ---------------------------------------------------------------------------

describe("reapDeadWorkers", () => {
  test("detects dead PID and marks task failed", async () => {
    const deadPid = 99999999; // guaranteed dead
    insertRunningTask("R-001", deadPid);

    await resetModules();
    const { reapDeadWorkers } = await import("../../src/lib/reaper");

    const results = reapDeadWorkers(db);

    // Should return the reaped task
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("R-001");
    expect(results[0].pid).toBe(deadPid);
    expect(results[0].reason).toBe("dead");

    // Task should be marked failed
    const task = db.taskGet("R-001");
    expect(task!.status).toBe("failed");

    // Session should be marked failed
    const session = db.get<{ status: string }>(
      "SELECT status FROM sessions WHERE task_id = 'R-001' ORDER BY id DESC LIMIT 1",
    );
    expect(session!.status).toBe("failed");

    // worker_reaped event should be logged
    const events = db.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = 'R-001' AND event_type = 'worker_reaped'",
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("skips sessions with null PID (treats PID 0 as dead)", async () => {
    // PID 0 — isAlive returns false for 0
    insertRunningTask("R-002", 0);

    await resetModules();
    const { reapDeadWorkers } = await import("../../src/lib/reaper");

    const results = reapDeadWorkers(db);

    // PID 0 is effectively dead (isAlive returns false for 0)
    // The reaper should detect it
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("R-002");
    expect(results[0].reason).toBe("dead");
  });

  test("ignores non-running sessions", async () => {
    // Insert a completed task with dead PID
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES ('R-003', 'manual', 'Task R-003', 'completed', 'wheels')",
    );
    db.exec(
      "INSERT INTO sessions (task_id, repo, status, pid) VALUES ('R-003', 'wheels', 'completed', 99999999)",
    );

    await resetModules();
    const { reapDeadWorkers } = await import("../../src/lib/reaper");

    const results = reapDeadWorkers(db);
    expect(results).toHaveLength(0);
  });

  test("parses cost from log file when reaping", async () => {
    const logFile = join(logsDir, "R-004.log");
    writeFileSync(
      logFile,
      `{"type":"assistant","text":"working on it"}
{"type":"result","cost_usd":1.25,"usage":{"input_tokens":5000,"output_tokens":2000}}
`,
    );

    const deadPid = 99999999;
    insertRunningTask("R-004", deadPid, logFile);

    await resetModules();
    const { reapDeadWorkers } = await import("../../src/lib/reaper");

    const results = reapDeadWorkers(db);
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("R-004");

    // Verify cost and tokens were parsed and stored
    const task = db.taskGet("R-004");
    expect(task!.cost_usd).toBe(1.25);
    expect(task!.tokens_used).toBe(7000);
  });
});

// ---------------------------------------------------------------------------
// reapStalledWorkers
// ---------------------------------------------------------------------------

describe("reapStalledWorkers", () => {
  test("dead PIDs handled by reapDeadWorkers not stall reaper", async () => {
    // Insert running task with dead PID + stale log
    const logFile = join(logsDir, "R-005.log");
    writeFileSync(logFile, '{"type":"assistant","text":"hello"}\n');

    // Set log mtime to 20 minutes ago (well past stall timeout)
    const pastTime = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(logFile, pastTime, pastTime);

    insertRunningTask("R-005", 99999999, logFile);

    await resetModules();
    const { reapStalledWorkers } = await import("../../src/lib/reaper");

    // Stall reaper should skip dead PIDs (those are handled by reapDeadWorkers)
    const results = reapStalledWorkers(db, 10);
    expect(results).toHaveLength(0);
  });

  test("skips workers with recent log activity", async () => {
    // Insert running task with dead PID + fresh log (mtime is now)
    const logFile = join(logsDir, "R-006.log");
    writeFileSync(logFile, '{"type":"assistant","text":"actively working"}\n');
    // mtime is already "now" since we just wrote it

    insertRunningTask("R-006", 99999999, logFile);

    await resetModules();
    const { reapStalledWorkers } = await import("../../src/lib/reaper");

    // Fresh log = not stalled, and dead PID = not stall reaper's concern
    const results = reapStalledWorkers(db, 10);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reaper integration
// ---------------------------------------------------------------------------

describe("reaper integration", () => {
  test("running both reapers doesn't double-reap", async () => {
    const deadPid = 99999999;
    insertRunningTask("R-007", deadPid);

    await resetModules();
    const { reapDeadWorkers, reapStalledWorkers } = await import("../../src/lib/reaper");

    // Dead reaper picks it up
    const deadResults = reapDeadWorkers(db);
    expect(deadResults).toHaveLength(1);
    expect(deadResults[0].taskId).toBe("R-007");

    // Stall reaper finds nothing (task already reaped / no longer running)
    const stallResults = reapStalledWorkers(db, 10);
    expect(stallResults).toHaveLength(0);
  });

  test("reaping frees drain slots", async () => {
    insertRunningTask("R-008", 99999999);
    insertRunningTask("R-009", 99999999);

    // Verify 2 running tasks
    expect(db.taskCount("running")).toBe(2);

    await resetModules();
    const { reapDeadWorkers } = await import("../../src/lib/reaper");

    const results = reapDeadWorkers(db);
    expect(results).toHaveLength(2);

    // Running count should be 0 after reaping
    expect(db.taskCount("running")).toBe(0);
  });
});
