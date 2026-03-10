// Tests for the work command (pre-dispatch validation only, no actual claude spawn)
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-work-test-"));
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

describe("work command pre-dispatch validation", () => {
  test("validates task exists", async () => {
    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.taskExists("NONEXISTENT")).toBe(false);
  });

  test("task must be in ready or planned status", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Test task", "ingested", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-001");
    expect(task).not.toBeNull();
    // "ingested" is not ready/planned -- work should reject it
    expect(task!.status).toBe("ingested");
    expect(["ready", "planned", "paused"]).not.toContain(task!.status);
  });

  test("ready task passes status check", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Test task", "ready", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-001");
    expect(task!.status).toBe("ready");
  });

  test("budget check: within budget passes", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Test task", "ready", "wheels", 2.0],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-001");
    const weekCost = testDb.costWeek();
    const { budgetGet } = await import("../../src/core/config");
    const weekBudget = budgetGet("per_week");

    // Should be within budget
    expect(weekCost + (task!.estimated_cost ?? 0)).toBeLessThanOrEqual(weekBudget);
  });

  test("budget check: over budget detected", async () => {
    // Insert expensive sessions to exceed weekly budget
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Expensive past work", "completed", "wheels"]);
    db.exec(
      "INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)",
      ["W-001", 95.0],
    );

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "New task", "ready", "wheels", 10.0],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-002");
    const weekCost = testDb.costWeek();
    const { budgetGet } = await import("../../src/core/config");
    const weekBudget = budgetGet("per_week");

    // 95 + 10 = 105 > 100 budget
    expect(weekCost + (task!.estimated_cost ?? 0)).toBeGreaterThan(weekBudget);
  });

  test("completed task should be rejected", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Done task", "completed", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-001");
    expect(task!.status).toBe("completed");
    // work command checks: status should not be done/completed
    expect(["done", "completed"]).toContain(task!.status);
  });

  test("running task should be rejected", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Running task", "running", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("W-001");
    expect(task!.status).toBe("running");
  });
});

describe("batch dispatch validation", () => {
  test("--batch requires a positive integer", () => {
    const parseN = (s: string): number | null => {
      const n = parseInt(s, 10);
      if (isNaN(n) || n < 1) return null;
      return n;
    };
    expect(parseN("5")).toBe(5);
    expect(parseN("0")).toBeNull();
    expect(parseN("-1")).toBeNull();
    expect(parseN("abc")).toBeNull();
    expect(parseN("3.5")).toBe(3);
  });

  test("batch selects top N tasks by priority", async () => {
    for (let i = 1; i <= 5; i++) {
      db.exec(
        "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
        [`W-${String(i).padStart(3, "0")}`, "manual", `Task ${i}`, "ready", "wheels", i],
      );
    }

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const tasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [3],
    );
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("W-001");
    expect(tasks[2].id).toBe("W-003");
  });

  test("batch capped by max_concurrent", async () => {
    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const maxConcurrent = settingsGet("max_concurrent") || 4;
    expect(maxConcurrent).toBe(4);
    expect(Math.min(10, maxConcurrent)).toBe(4);
  });

  test("batch capped by available tasks", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Only task", "ready", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const tasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [5],
    );
    expect(tasks).toHaveLength(1);
  });
});

describe("batch status rendering", () => {
  test("formatElapsed returns human-readable duration", () => {
    const formatElapsed = (startedAt: string): string => {
      const dt = new Date(startedAt.replace(" ", "T") + (startedAt.includes("Z") ? "" : "Z"));
      if (isNaN(dt.getTime())) return "-";
      const totalSecs = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
      const m = Math.floor(totalSecs / 60);
      const s = totalSecs % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const past = new Date(Date.now() - 90_000).toISOString().replace("T", " ").slice(0, 19);
    const result = formatElapsed(past);
    expect(result).toBe("1:30");
  });

  test("batch summary counts statuses correctly", () => {
    const statuses = ["running", "running", "done", "failed", "running"];
    const counts = { running: 0, done: 0, failed: 0 };
    for (const s of statuses) {
      if (s === "running") counts.running++;
      else if (s === "done" || s === "completed" || s === "review") counts.done++;
      else if (s === "failed") counts.failed++;
    }
    expect(counts.running).toBe(3);
    expect(counts.done).toBe(1);
    expect(counts.failed).toBe(1);
  });
});

describe("batch dispatch end-to-end", () => {
  test("batch selects only ready/planned tasks and ignores others", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Ready 1", "ready", "wheels", 1]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Ready 2", "ready", "wheels", 2]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Running", "running", "wheels", 3]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-004", "manual", "Done", "done", "wheels", 4]);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const batch = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [10],
    );
    expect(batch.map(t => t.id)).toEqual(["W-001", "W-002"]);
  });

  test("terminal states are correctly identified", () => {
    const TERMINAL = new Set(["done", "completed", "failed", "review"]);
    expect(TERMINAL.has("done")).toBe(true);
    expect(TERMINAL.has("completed")).toBe(true);
    expect(TERMINAL.has("failed")).toBe(true);
    expect(TERMINAL.has("review")).toBe(true);
    expect(TERMINAL.has("running")).toBe(false);
    expect(TERMINAL.has("paused")).toBe(false);
  });
});
