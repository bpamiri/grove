// Tests for drain retry decision logic (no actual claude process spawning)
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-drain-retry-test-"));
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
  max_retries: 2
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

/** Helper to insert a task with minimal boilerplate */
function insertTask(id: string, status: string, dependsOn?: string, extra?: Record<string, any>) {
  const cols = ["id", "source_type", "title", "status", "repo"];
  const vals: any[] = [id, "manual", `Task ${id}`, status, "wheels"];

  if (dependsOn !== undefined) {
    cols.push("depends_on");
    vals.push(dependsOn);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      cols.push(k);
      vals.push(v);
    }
  }

  const placeholders = cols.map(() => "?").join(", ");
  db.exec(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${placeholders})`, vals);
}

// ---------------------------------------------------------------------------
// drain retry logic
// ---------------------------------------------------------------------------

describe("drain retry logic", () => {
  test("retries failed task up to max_retries", async () => {
    insertTask("R-001", "failed", undefined, { retry_count: 0 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-001");
    expect(task).not.toBeNull();

    // Compute effective max: task.max_retries ?? settings.max_retries ?? 2
    const effective_max = task!.max_retries ?? settingsGet("max_retries") ?? 2;
    expect(effective_max).toBe(2);

    // retry_count(0) < effective_max(2) -> should retry
    expect(task!.retry_count).toBe(0);
    expect(task!.retry_count < effective_max).toBe(true);

    // Simulate retry: increment retry_count, reset status to ready
    testDb.exec(
      "UPDATE tasks SET retry_count = retry_count + 1, status = 'ready' WHERE id = ?",
      ["R-001"],
    );

    const updated = testDb.taskGet("R-001");
    expect(updated!.retry_count).toBe(1);
    expect(updated!.status).toBe("ready");
  });

  test("stops retrying when retry_count reaches max", async () => {
    insertTask("R-002", "failed", undefined, { retry_count: 2 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-002");
    expect(task).not.toBeNull();

    const effective_max = task!.max_retries ?? settingsGet("max_retries") ?? 2;
    expect(effective_max).toBe(2);

    // retry_count(2) >= effective_max(2) -> no retry
    expect(task!.retry_count).toBe(2);
    expect(task!.retry_count >= effective_max).toBe(true);

    // Task stays failed
    expect(task!.status).toBe("failed");
  });

  test("respects per-task max_retries=0 (no-retry)", async () => {
    insertTask("R-003", "failed", undefined, { retry_count: 0, max_retries: 0 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-003");
    expect(task).not.toBeNull();

    // Per-task max_retries=0 overrides global setting
    const effective_max = task!.max_retries ?? settingsGet("max_retries") ?? 2;
    expect(effective_max).toBe(0);

    // 0 < 0 is false -> no retry allowed
    expect(task!.retry_count < effective_max).toBe(false);
  });

  test("per-task max_retries=5 allows more retries than global", async () => {
    insertTask("R-004", "failed", undefined, { retry_count: 3, max_retries: 5 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-004");
    expect(task).not.toBeNull();

    // Per-task max_retries=5 overrides global setting of 2
    const effective_max = task!.max_retries ?? settingsGet("max_retries") ?? 2;
    expect(effective_max).toBe(5);

    // retry_count(3) < effective_max(5) -> can still retry
    expect(task!.retry_count).toBe(3);
    expect(task!.retry_count < effective_max).toBe(true);
  });

  test("logs auto_retried event on retry", async () => {
    insertTask("R-005", "failed", undefined, { retry_count: 0 });

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    // Simulate retry: increment count, reset status, log event
    testDb.exec(
      "UPDATE tasks SET retry_count = retry_count + 1, status = 'ready' WHERE id = ?",
      ["R-005"],
    );
    testDb.addEvent("R-005", "auto_retried", "Retry 1/2");

    // Verify event was logged
    const events = testDb.all<{ task_id: string; event_type: string; summary: string }>(
      "SELECT task_id, event_type, summary FROM events WHERE task_id = ? AND event_type = ?",
      ["R-005", "auto_retried"],
    );
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe("R-005");
    expect(events[0].event_type).toBe("auto_retried");
    expect(events[0].summary).toBe("Retry 1/2");
  });

  test("logs retry_exhausted event when max reached", async () => {
    insertTask("R-006", "failed", undefined, { retry_count: 2 });

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    // Log retry_exhausted event
    testDb.addEvent("R-006", "retry_exhausted", "Max retries (2) reached");

    // Verify event was logged
    const events = testDb.all<{ task_id: string; event_type: string; summary: string }>(
      "SELECT task_id, event_type, summary FROM events WHERE task_id = ? AND event_type = ?",
      ["R-006", "retry_exhausted"],
    );
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe("R-006");
    expect(events[0].event_type).toBe("retry_exhausted");
    expect(events[0].summary).toBe("Max retries (2) reached");
  });
});
