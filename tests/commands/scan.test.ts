// Tests for the scan command
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");
const projectRoot = join(import.meta.dir, "../..");

let tempDir: string;
let repoDir: string;
let db: Database;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };
let originalExit: typeof process.exit;
let exited: boolean;
let errorOutput: string[];
let logOutput: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-scan-test-"));

  // Create a real repo directory with source files containing TODOs
  repoDir = join(tempDir, "repo-wheels");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "app.ts"), '// TODO: fix bug\nconsole.log("hello");\n');

  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;

  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  // Seed repos in DB (FK constraint requires these)
  db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: repoDir, branch_prefix: "grove/", claude_md_path: null, last_synced: null });

  // Write config — path points to real temp directory
  writeFileSync(
    join(tempDir, "grove.yaml"),
    `
workspace:
  name: "Test"
repos:
  wheels:
    org: cfwheels
    github: cfwheels/wheels
    path: ${repoDir}
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

// ---------------------------------------------------------------------------
// scan command tests
// ---------------------------------------------------------------------------

describe("scan command", () => {
  test("default (no flags) shows dry-run output", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run([]);

    const allOutput = logOutput.join("\n");
    expect(allOutput).toContain("Dry Run");
    expect(allOutput).toContain("TODO");
    expect(allOutput).toContain("fix bug");
  });

  test("--apply creates ingested tasks", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--apply"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const tasks = verifyDb.all<{ id: string; source_type: string; status: string; source_ref: string }>(
      "SELECT id, source_type, status, source_ref FROM tasks WHERE source_type = 'scan'"
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].status).toBe("ingested");
    expect(tasks[0].source_ref).toMatch(/^scan:/);
    verifyDb.close();
  });

  test("--apply deduplicates by source_ref", async () => {
    // Pre-insert a task with the source_ref that scanMarkers would generate
    const expectedRef = "scan:wheels:src/app.ts:1:TODO";
    db.exec(
      "INSERT INTO tasks (id, repo, source_type, source_ref, title, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-099", "wheels", "scan", expectedRef, "Existing", "ingested", 50],
    );

    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--apply"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const tasks = verifyDb.all("SELECT * FROM tasks WHERE source_type = 'scan'");
    expect(tasks.length).toBe(1); // no new task created
    verifyDb.close();
  });

  test("--repo filters to specific repo", async () => {
    // Add second repo with its own temp dir and TODOs
    const otherDir = join(tempDir, "repo-other");
    mkdirSync(join(otherDir, "src"), { recursive: true });
    writeFileSync(join(otherDir, "src", "index.ts"), "// TODO: other thing\n");

    db.repoUpsert({ name: "other", org: "test", github_full: "test/other", local_path: otherDir, branch_prefix: "grove/", claude_md_path: null, last_synced: null });

    // Update grove.yaml to include both repos
    writeFileSync(
      join(tempDir, "grove.yaml"),
      `
workspace:
  name: "Test"
repos:
  wheels:
    org: cfwheels
    github: cfwheels/wheels
    path: ${repoDir}
  other:
    org: test
    github: test/other
    path: ${otherDir}
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

    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--repo", "wheels"]);

    const allOutput = logOutput.join("\n");
    expect(allOutput).toContain("wheels");
    expect(allOutput).not.toContain("other");
  });

  test("--limit caps findings per repo", async () => {
    // Write 10 TODO files in repoDir
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(repoDir, "src", `file${i}.ts`), `// TODO: task number ${i}\n`);
    }

    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--limit", "3", "--dry-run"]);

    const allOutput = logOutput.join("\n");
    // The repo summary line should show 3 finding(s)
    expect(allOutput).toContain("3 finding(s)");
  });

  test("unknown flag shows error", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--bogus"]);

    expect(exited).toBe(true);
    const allErrors = errorOutput.join("\n");
    expect(allErrors).toContain("Unknown flag");
  });

  test("--help shows help text", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--help"]);

    const allOutput = logOutput.join("\n");
    expect(allOutput).toContain("Usage: grove scan");
  });

  test("no repos configured shows error", async () => {
    // Overwrite grove.yaml with empty repos section
    writeFileSync(
      join(tempDir, "grove.yaml"),
      `
workspace:
  name: "Test"
repos: {}
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

    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run([]);

    expect(exited).toBe(true);
    const allErrors = errorOutput.join("\n");
    expect(allErrors).toContain("No repos configured");
  });

  test("apply mode assigns priority 50 to marker findings", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run(["--apply"]);

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const tasks = verifyDb.all<{ priority: number }>(
      "SELECT priority FROM tasks WHERE source_type = 'scan'"
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].priority).toBe(50);
    verifyDb.close();
  });

  test("dry-run shows total count and apply hint", async () => {
    await resetModules();
    const { scanCommand } = await import("../../src/commands/scan");
    await scanCommand.run([]);

    const allOutput = logOutput.join("\n");
    expect(allOutput).toContain("finding(s)");
    expect(allOutput).toContain("--apply");
  });
});
