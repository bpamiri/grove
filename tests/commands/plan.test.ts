// Tests for the plan command (strategy detection, cost estimation, auto-approve)
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
  tempDir = mkdtempSync(join(tmpdir(), "grove-plan-test-"));
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
  auto_approve_under: 5
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

describe("planCommand strategy detection", () => {
  test("'audit all modules' -> sweep strategy", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "audit all modules for consistency", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    // Re-read from fresh connection
    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.strategy).toBe("sweep");
    verifyDb.close();
  });

  test("'refactor the router' -> team strategy", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "refactor the router module", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.strategy).toBe("team");
    verifyDb.close();
  });

  test("'fix login bug' -> solo strategy", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "fix login bug", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.strategy).toBe("solo");
    verifyDb.close();
  });

  test("'cross-repo migration' -> pipeline strategy", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "cross-repo migration of auth module", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.strategy).toBe("pipeline");
    verifyDb.close();
  });
});

describe("planCommand cost estimation", () => {
  test("solo tasks get estimated cost of 2", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "fix a small bug", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.estimated_cost).toBe(2);
    verifyDb.close();
  });

  test("sweep tasks get estimated cost of 3", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "audit all modules", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.estimated_cost).toBe(3);
    verifyDb.close();
  });

  test("team tasks get estimated cost based on team size", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "refactor the router", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    // team size 2 * 2 = 4
    expect(task!.estimated_cost).toBe(4);
    verifyDb.close();
  });
});

describe("planCommand auto-approve", () => {
  test("auto-promotes to ready when under threshold", async () => {
    // auto_approve_under is 5 in our config, solo cost is 2
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "fix a small bug", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.status).toBe("ready"); // auto-approved
    verifyDb.close();
  });

  test("stays planned when over threshold", async () => {
    // pipeline cost is 8, threshold is 5
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "cross-repo end-to-end migration", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-001");
    expect(task!.status).toBe("planned"); // not auto-approved
    verifyDb.close();
  });

  test("auto-approve logs event", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "fix a small bug", "ingested"],
    );

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run(["W-001"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const events = verifyDb.all<{ event_type: string }>(
      "SELECT event_type FROM events WHERE task_id = 'W-001'",
    );
    expect(events.some((e) => e.event_type === "auto_approved")).toBe(true);
    verifyDb.close();
  });
});

describe("planCommand batch mode", () => {
  test("plans all ingested tasks when no ID given", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-001", "manual", "fix bug one", "ingested"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-002", "manual", "fix bug two", "ingested"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["W-003", "manual", "already planned", "planned"]);

    await resetModules();
    const { planCommand } = await import("../../src/commands/plan");
    await planCommand.run([]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    // Both ingested tasks should now be planned (or ready due to auto-approve)
    const w1 = verifyDb.taskGet("W-001");
    const w2 = verifyDb.taskGet("W-002");
    expect(w1!.strategy).not.toBeNull();
    expect(w2!.strategy).not.toBeNull();

    // W-003 should still be planned (not re-planned)
    const w3 = verifyDb.taskGet("W-003");
    expect(w3!.strategy).toBeNull(); // wasn't touched
    verifyDb.close();
  });
});
