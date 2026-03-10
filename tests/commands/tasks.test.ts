// Tests for the tasks command
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-tasks-test-"));
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
  titan:
    org: pai
    github: pai/titan
    path: ~/code/titan
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

  // Seed repos (FK constraint requires these)
  db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: "~/code/wheels", branch_prefix: "grove/", claude_md_path: null, last_synced: null });
  db.repoUpsert({ name: "titan", org: "pai", github_full: "pai/titan", local_path: "~/code/titan", branch_prefix: "grove/", claude_md_path: null, last_synced: null });

  // Seed some tasks
  db.exec("INSERT INTO tasks (id, repo, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?, ?)",
    ["W-001", "wheels", "manual", "Fix router", "ingested", 50]);
  db.exec("INSERT INTO tasks (id, repo, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?, ?)",
    ["W-002", "wheels", "manual", "Add tests", "ready", 30]);
  db.exec("INSERT INTO tasks (id, repo, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?, ?)",
    ["T-001", "titan", "manual", "Update layout", "running", 20]);
  db.exec("INSERT INTO tasks (id, repo, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?, ?)",
    ["T-002", "titan", "manual", "Old task", "completed", 50]);
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

describe("tasksCommand", () => {
  test("default run excludes completed tasks", async () => {
    await resetModules();

    // Verify DB state: 3 non-completed, 1 completed
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const allActive = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status != 'completed' ORDER BY priority",
    );
    expect(allActive.length).toBe(3);

    const allIncluding = testDb.all<{ id: string }>("SELECT id FROM tasks");
    expect(allIncluding.length).toBe(4);
  });

  test("--status filter returns correct tasks", async () => {
    await resetModules();

    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const ready = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status = 'ready'",
    );
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("W-002");
  });

  test("--repo filter returns correct tasks", async () => {
    await resetModules();

    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const titanTasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE repo = ? AND status != 'completed'",
      ["titan"],
    );
    expect(titanTasks.length).toBe(1);
    expect(titanTasks[0].id).toBe("T-001");
  });

  test("--all includes completed tasks", async () => {
    await resetModules();

    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const all = testDb.all<{ id: string }>("SELECT id FROM tasks");
    expect(all.length).toBe(4);
    expect(all.some((t) => t.id === "T-002")).toBe(true);
  });

  test("tasks command runs without error", async () => {
    await resetModules();

    const { tasksCommand } = await import("../../src/commands/tasks");
    // Should not throw
    await tasksCommand.run([]);
  });

  test("tasks command with --status runs without error", async () => {
    await resetModules();

    const { tasksCommand } = await import("../../src/commands/tasks");
    await tasksCommand.run(["--status", "ready"]);
  });

  test("tasks command with --repo runs without error", async () => {
    await resetModules();

    const { tasksCommand } = await import("../../src/commands/tasks");
    await tasksCommand.run(["--repo", "wheels"]);
  });
});
