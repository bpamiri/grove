// Tests for health command — worker health reporting and reaping
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-health-test-"));
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
  db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: "~/code/wheels", branch_prefix: "grove/", claude_md_path: null, last_synced: null });
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

/** Helper to insert a task */
function insertTask(id: string, status: string, extra?: Record<string, any>) {
  const cols = ["id", "source_type", "title", "status", "repo"];
  const vals: any[] = [id, "manual", `Task ${id}`, status, "wheels"];

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      cols.push(k);
      vals.push(v);
    }
  }

  const placeholders = cols.map(() => "?").join(", ");
  db.exec(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${placeholders})`, vals);
}

/** Helper to insert a session */
function insertSession(taskId: string, status: string, pid: number, outputLog?: string) {
  const cols = ["task_id", "repo", "status", "pid"];
  const vals: any[] = [taskId, "wheels", status, pid];

  if (outputLog !== undefined) {
    cols.push("output_log");
    vals.push(outputLog);
  }

  const placeholders = cols.map(() => "?").join(", ");
  db.exec(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`, vals);
}

// ---------------------------------------------------------------------------
// health report data
// ---------------------------------------------------------------------------

describe("health report data", () => {
  test("lists running sessions with PID status", async () => {
    // Insert a running task with a dead PID (99999999 should not exist)
    insertTask("H-001", "running");
    insertSession("H-001", "running", 99999999);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const sessions = testDb.all<{ id: number; task_id: string; pid: number }>(
      "SELECT id, task_id, pid FROM sessions WHERE status = 'running'",
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].task_id).toBe("H-001");
    expect(sessions[0].pid).toBe(99999999);

    // Verify isAlive reports this PID as dead
    const { isAlive } = await import("../../src/lib/monitor");
    expect(isAlive(99999999)).toBe(false);
  });

  test("reports no workers when none running", async () => {
    // Insert a completed task with a completed session
    insertTask("H-002", "completed");
    insertSession("H-002", "completed", 12345);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const sessions = testDb.all<{ id: number }>(
      "SELECT id FROM sessions WHERE status = 'running'",
    );

    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// health --reap
// ---------------------------------------------------------------------------

describe("health --reap", () => {
  test("reap cleans up dead workers", async () => {
    // Insert a running task with a dead PID
    insertTask("H-003", "running");
    insertSession("H-003", "running", 99999999);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    // Verify task is running before reap
    const taskBefore = testDb.taskGet("H-003");
    expect(taskBefore!.status).toBe("running");

    // Reap dead workers
    const { reapDeadWorkers } = await import("../../src/lib/reaper");
    const results = reapDeadWorkers(testDb);

    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("H-003");
    expect(results[0].reason).toBe("dead");

    // Verify task is now failed
    const taskAfter = testDb.taskGet("H-003");
    expect(taskAfter!.status).toBe("failed");

    // Verify session is now failed
    const session = testDb.get<{ status: string }>(
      "SELECT status FROM sessions WHERE task_id = 'H-003'",
    );
    expect(session!.status).toBe("failed");
  });
});
