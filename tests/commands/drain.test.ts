// Tests for drain command queue logic (no actual claude process spawning)
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-drain-test-"));
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
// drain queue building
// ---------------------------------------------------------------------------

describe("drain queue building", () => {
  test("collects ready and planned tasks, excludes blocked", async () => {
    insertTask("D-001", "ready", undefined, { priority: 1 });
    insertTask("D-002", "planned", undefined, { priority: 2 });
    insertTask("D-003", "ready", "D-999", { priority: 3 }); // blocked: D-999 doesn't exist
    insertTask("D-004", "done");
    insertTask("D-005", "running");

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    // Drain collects ready + planned candidates
    const candidates = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC",
    );
    expect(candidates).toHaveLength(3); // D-001, D-002, D-003

    // Filter out blocked
    const unblocked = candidates.filter((t) => !testDb.isTaskBlocked(t.id));
    expect(unblocked.map((t) => t.id)).toEqual(["D-001", "D-002"]);
  });

  test("newly unblocked tasks enter the queue", async () => {
    insertTask("D-001", "done");                    // finished dependency
    insertTask("D-002", "ready", "D-001");           // dep satisfied -> unblocked
    insertTask("D-003", "ready", "D-001,D-999");     // D-999 still missing -> blocked

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.isTaskBlocked("D-002")).toBe(false);
    expect(testDb.isTaskBlocked("D-003")).toBe(true);
  });

  test("getNewlyUnblocked finds tasks freed by completion", async () => {
    insertTask("D-001", "running");                  // about to complete
    insertTask("D-002", "ready", "D-001");           // single dep on D-001
    insertTask("D-003", "ready", "D-001,D-004");     // also depends on D-004
    insertTask("D-004", "done");                     // already done

    // Simulate D-001 completing
    db.exec("UPDATE tasks SET status = 'done' WHERE id = 'D-001'");

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const unblocked = testDb.getNewlyUnblocked("D-001");
    const ids = unblocked.map((t) => t.id).sort();

    // D-002: sole dep D-001 now done -> unblocked
    // D-003: both D-001 and D-004 are done -> unblocked
    expect(ids).toEqual(["D-002", "D-003"]);
  });
});

// ---------------------------------------------------------------------------
// drain slot management
// ---------------------------------------------------------------------------

describe("drain slot management", () => {
  test("respects concurrency limit", async () => {
    // Insert 6 ready tasks
    for (let i = 1; i <= 6; i++) {
      insertTask(`D-${String(i).padStart(3, "0")}`, "ready", undefined, { priority: i });
    }

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const { settingsGet } = await import("../../src/core/config");
    const testDb = getDb();

    const maxConcurrent = settingsGet("max_concurrent") || 4;
    expect(maxConcurrent).toBe(4);

    // Scenario 1: 0 running tasks -> 4 available slots
    const runningCount0 = testDb.taskCount("running");
    expect(runningCount0).toBe(0);
    const availableSlots0 = maxConcurrent - runningCount0;
    expect(availableSlots0).toBe(4);

    // 6 ready tasks but only 4 slots
    const candidates = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC LIMIT ?",
      [availableSlots0],
    );
    expect(candidates).toHaveLength(4);

    // Scenario 2: mark 2 tasks as running -> 2 available slots
    db.exec("UPDATE tasks SET status = 'running' WHERE id IN ('D-001', 'D-002')");

    // Re-query after module reset to pick up changes
    const { closeDb } = await import("../../src/core/db");
    closeDb();
    const config = await import("../../src/core/config");
    config.reloadConfig();

    const testDb2 = (await import("../../src/core/db")).getDb();
    const runningCount2 = testDb2.taskCount("running");
    expect(runningCount2).toBe(2);
    const availableSlots2 = maxConcurrent - runningCount2;
    expect(availableSlots2).toBe(2);

    const candidates2 = testDb2.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC LIMIT ?",
      [availableSlots2],
    );
    expect(candidates2).toHaveLength(2);
    expect(candidates2[0].id).toBe("D-003");
    expect(candidates2[1].id).toBe("D-004");
  });

  test("budget check prevents dispatch when exceeded", async () => {
    // Insert a task with estimated cost
    insertTask("D-001", "ready", undefined, { estimated_cost: 15.0 });

    // Insert a completed task with an expensive session consuming most budget
    insertTask("D-PAST", "completed");
    db.exec(
      "INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)",
      ["D-PAST", 90.0],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const { budgetGet } = await import("../../src/core/config");
    const testDb = getDb();

    const weekCost = testDb.costWeek();
    const weekBudget = budgetGet("per_week");
    const task = testDb.taskGet("D-001");
    const estimatedCost = task!.estimated_cost ?? 0;

    // 90 + 15 = 105 > 100 budget
    expect(weekBudget).toBe(100);
    expect(weekCost + estimatedCost).toBeGreaterThan(weekBudget);
  });
});

// ---------------------------------------------------------------------------
// drain --dry-run
// ---------------------------------------------------------------------------

describe("drain --dry-run", () => {
  test("reports tasks that would be dispatched", async () => {
    insertTask("D-001", "ready", undefined, { priority: 1 });
    insertTask("D-002", "planned", undefined, { priority: 2 });
    insertTask("D-003", "ready", "D-999", { priority: 3 }); // blocked
    insertTask("D-004", "running");                          // already running
    insertTask("D-005", "done");                             // already done

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const { settingsGet } = await import("../../src/core/config");
    const testDb = getDb();

    const maxConcurrent = settingsGet("max_concurrent") || 4;
    const runningCount = testDb.taskCount("running");
    const availableSlots = maxConcurrent - runningCount; // 4 - 1 = 3

    // Gather candidates (ready + planned)
    const candidates = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC LIMIT ?",
      [availableSlots],
    );

    // Partition into unblocked (would dispatch) and blocked (would skip)
    const wouldDispatch = candidates.filter((t) => !testDb.isTaskBlocked(t.id));
    const wouldSkip = candidates.filter((t) => testDb.isTaskBlocked(t.id));

    expect(wouldDispatch.map((t) => t.id)).toEqual(["D-001", "D-002"]);
    expect(wouldSkip.map((t) => t.id)).toEqual(["D-003"]);
  });
});

// ---------------------------------------------------------------------------
// drain termination
// ---------------------------------------------------------------------------

describe("drain termination", () => {
  test("terminates when queue empty and no running tasks", async () => {
    insertTask("D-001", "done");
    insertTask("D-002", "completed");
    insertTask("D-003", "failed");

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    // No ready/planned candidates
    const candidates = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC",
    );
    expect(candidates).toHaveLength(0);

    // No running tasks
    const runningCount = testDb.taskCount("running");
    expect(runningCount).toBe(0);

    // Drain should terminate: empty queue + zero running
    const shouldTerminate = candidates.length === 0 && runningCount === 0;
    expect(shouldTerminate).toBe(true);
  });
});
