// Tests for the edit command
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
let originalExit: typeof process.exit;
let exited: boolean;
let errorOutput: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-edit-test-"));
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
  db.repoUpsert({ name: "titan", org: "pai", github_full: "pai/titan", local_path: "~/code/titan", branch_prefix: "grove/", claude_md_path: null, last_synced: null });

  // Write config with repos and max_retries
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
  // Store for restore
  (globalThis as any).__origConsoleError = origError;
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

/** Helper to insert a task with minimal boilerplate */
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

// ---------------------------------------------------------------------------
// Single field edits
// ---------------------------------------------------------------------------

describe("editCommand single field edits", () => {
  test("edit title via --title flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "New Title"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.title).toBe("New Title");
    verifyDb.close();
  });

  test("edit description via --description flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--description", "Detailed description here"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.description).toBe("Detailed description here");
    verifyDb.close();
  });

  test("edit priority via --priority flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--priority", "10"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.priority).toBe(10);
    verifyDb.close();
  });

  test("edit repo via --repo flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--repo", "titan"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.repo).toBe("titan");
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Multi-field edit
// ---------------------------------------------------------------------------

describe("editCommand multi-field edit", () => {
  test("edit multiple fields at once (title + priority + repo)", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "Updated Title", "--priority", "5", "--repo", "titan"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.title).toBe("Updated Title");
    expect(task!.priority).toBe(5);
    expect(task!.repo).toBe("titan");
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Status gates
// ---------------------------------------------------------------------------

describe("editCommand status gates", () => {
  test("block edit on done status", async () => {
    insertTask("W-001", "done");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "Should not work"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("done"))).toBe(true);

    // Title should remain unchanged
    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.title).toBe("Task W-001");
    verifyDb.close();
  });

  test("block edit on failed status", async () => {
    insertTask("W-001", "failed");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "Should not work"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("failed"))).toBe(true);
  });

  test("allow edit on paused status", async () => {
    insertTask("W-001", "paused");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "Paused Edit Works"]);

    expect(exited).toBe(false);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.title).toBe("Paused Edit Works");
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Dependency editing
// ---------------------------------------------------------------------------

describe("editCommand dependency editing", () => {
  test("edit depends_on with valid IDs", async () => {
    insertTask("W-001", "ready");
    insertTask("W-002", "ready");
    insertTask("W-003", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-003", "--depends", "W-001,W-002"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-003");
    expect(task!.depends_on).toBe("W-001,W-002");
    verifyDb.close();
  });

  test("reject depends_on with nonexistent ID", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--depends", "W-999"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("W-999"))).toBe(true);
  });

  test("reject circular dependency (direct: A depends on B, try B depends on A)", async () => {
    insertTask("W-001", "ready", { depends_on: "W-002" });
    insertTask("W-002", "ready");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-002", "--depends", "W-001"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.toLowerCase().includes("circular"))).toBe(true);
  });

  test("deep circular dependency (A->B->C, try C->A)", async () => {
    insertTask("W-001", "ready", { depends_on: "W-002" });
    insertTask("W-002", "ready", { depends_on: "W-003" });
    insertTask("W-003", "ready");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-003", "--depends", "W-001"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.toLowerCase().includes("circular"))).toBe(true);
  });

  test("clear depends_on with empty string", async () => {
    insertTask("W-001", "ready");
    insertTask("W-002", "ready", { depends_on: "W-001" });

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-002", "--depends", ""]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-002");
    expect(task!.depends_on).toBeNull();
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Retry settings
// ---------------------------------------------------------------------------

describe("editCommand retry settings", () => {
  test("edit max_retries via --max-retries flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--max-retries", "5"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.max_retries).toBe(5);
    verifyDb.close();
  });

  test("--no-retry sets max_retries to 0", async () => {
    insertTask("W-001", "ingested", { max_retries: 3 });

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--no-retry"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.max_retries).toBe(0);
    verifyDb.close();
  });
});

// ---------------------------------------------------------------------------
// Strategy editing
// ---------------------------------------------------------------------------

describe("editCommand strategy editing", () => {
  test("edit strategy via --strategy flag", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--strategy", "team"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.strategy).toBe("team");
    verifyDb.close();
  });

  test("reject invalid strategy", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--strategy", "bogus"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("bogus"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("editCommand validation", () => {
  test("reject invalid repo", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--repo", "nonexistent"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("nonexistent"))).toBe(true);
  });

  test("nonexistent task ID errors", async () => {
    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["Z-999", "--title", "Ghost"]);

    expect(exited).toBe(true);
    expect(errorOutput.some((msg) => msg.includes("Z-999"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event logging
// ---------------------------------------------------------------------------

describe("editCommand event logging", () => {
  test("logs event with changed field names", async () => {
    insertTask("W-001", "ingested");

    await resetModules();
    const { editCommand } = await import("../../src/commands/edit");
    await editCommand.run(["W-001", "--title", "New Title", "--priority", "10"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = 'W-001'",
    );
    // Should have an "edited" event that mentions the changed fields
    const editEvents = events.filter((e) => e.event_type === "status_change" && e.summary.includes("Edited"));
    expect(editEvents.length).toBeGreaterThanOrEqual(1);
    const summary = editEvents[0].summary;
    expect(summary).toContain("title");
    expect(summary).toContain("priority");
    verifyDb.close();
  });
});
