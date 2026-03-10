// Tests for the add command
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-add-test-"));
  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;

  // Set up DB
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  // Seed repos in DB (FK constraint requires these)
  db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: "~/code/wheels", branch_prefix: "grove/", claude_md_path: null, last_synced: null });
  db.repoUpsert({ name: "titan", org: "pai", github_full: "pai/titan", local_path: "~/code/titan", branch_prefix: "grove/", claude_md_path: null, last_synced: null });

  // Write config with a repo
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
});

afterEach(() => {
  db.close();

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

describe("addCommand", () => {
  test("non-interactive add with description and repo", async () => {
    await resetModules();

    const { addCommand } = await import("../../src/commands/add");
    // Non-interactive: pass description and repo via args. Suppress TTY prompts.
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true, configurable: true });

    try {
      await addCommand.run(["Fix route parsing", "--repo", "wheels"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }

    // Re-open the DB to verify
    const verifyDb = new Database(join(tempDir, "grove.db"));

    const task = verifyDb.taskGet("W-001");
    expect(task).not.toBeNull();
    expect(task!.id).toBe("W-001");
    expect(task!.title).toBe("Fix route parsing");
    expect(task!.repo).toBe("wheels");
    expect(task!.status).toBe("ingested");
    expect(task!.source_type).toBe("manual");
    expect(task!.priority).toBe(50);

    // Verify event logged
    const events = verifyDb.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = 'W-001'",
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.event_type === "created")).toBe(true);

    verifyDb.close();
  });

  test("task ID uses first letter of repo name", async () => {
    await resetModules();

    const { addCommand } = await import("../../src/commands/add");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true, configurable: true });

    try {
      await addCommand.run(["Fix something", "--repo", "titan"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("T-001");
    expect(task).not.toBeNull();
    expect(task!.repo).toBe("titan");
    verifyDb.close();
  });

  test("second task for same repo gets incremented ID", async () => {
    await resetModules();

    const { addCommand } = await import("../../src/commands/add");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true, configurable: true });

    try {
      await addCommand.run(["First task", "--repo", "wheels"]);
      await addCommand.run(["Second task", "--repo", "wheels"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }

    const verifyDb = new Database(join(tempDir, "grove.db"));
    expect(verifyDb.taskGet("W-001")).not.toBeNull();
    expect(verifyDb.taskGet("W-002")).not.toBeNull();
    expect(verifyDb.taskGet("W-002")!.title).toBe("Second task");
    verifyDb.close();
  });
});
