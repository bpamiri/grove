// Tests for config loading, dot-notation access, validation
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-config-test-"));
  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = join(import.meta.dir, "../..");
});

afterEach(() => {
  // Restore env
  if (originalEnv.GROVE_HOME !== undefined) process.env.GROVE_HOME = originalEnv.GROVE_HOME;
  else delete process.env.GROVE_HOME;
  if (originalEnv.GROVE_ROOT !== undefined) process.env.GROVE_ROOT = originalEnv.GROVE_ROOT;
  else delete process.env.GROVE_ROOT;

  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  writeFileSync(join(tempDir, "grove.yaml"), content);
}

function freshImport() {
  // We need to clear the cached _config and re-import to get clean state.
  // The simplest approach: directly manipulate the module's state by calling reloadConfig.
  // But we must also clear the module-level _config.
  // We'll use reloadConfig() which sets _config = null then reloads.
  return import("../../src/core/config");
}

describe("loadConfig", () => {
  test("loads and parses a grove.yaml file", async () => {
    writeConfig(`
workspace:
  name: "Test Workshop"
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
`);

    const { reloadConfig } = await freshImport();
    const config = reloadConfig();

    expect(config.workspace.name).toBe("Test Workshop");
    expect(config.budgets.per_week).toBe(100);
    expect(config.settings.max_concurrent).toBe(4);
  });
});

describe("configGet with dot notation", () => {
  test("accesses nested values", async () => {
    writeConfig(`
workspace:
  name: "Deep Nesting"
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
`);

    const { reloadConfig, configGet } = await freshImport();
    reloadConfig();

    expect(configGet("workspace.name")).toBe("Deep Nesting");
    expect(configGet("budgets.per_week")).toBe(100);
    expect(configGet("settings.auto_sync")).toBe(false);
    expect(configGet("settings.branch_prefix")).toBe("grove/");
  });

  test("returns undefined for missing keys", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, configGet } = await freshImport();
    reloadConfig();

    expect(configGet("nonexistent")).toBeUndefined();
    expect(configGet("workspace.missing")).toBeUndefined();
    expect(configGet("deep.nested.path")).toBeUndefined();
  });
});

describe("configSet + reload", () => {
  test("persists a value to disk and it survives reload", async () => {
    writeConfig(`
workspace:
  name: "Original"
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
`);

    const { reloadConfig, configGet, configSet } = await freshImport();
    reloadConfig();

    configSet("workspace.name", "Updated");
    expect(configGet("workspace.name")).toBe("Updated");

    // Force a reload from disk to verify persistence
    const config = reloadConfig();
    expect(config.workspace.name).toBe("Updated");
  });

  test("type coercion: numbers", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, configGet, configSet } = await freshImport();
    reloadConfig();

    configSet("budgets.per_week", "200");
    expect(configGet("budgets.per_week")).toBe(200);
  });

  test("type coercion: booleans", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, configGet, configSet } = await freshImport();
    reloadConfig();

    configSet("settings.auto_sync", "true");
    expect(configGet("settings.auto_sync")).toBe(true);
  });
});

describe("validateConfig", () => {
  test("valid config returns no errors", async () => {
    writeConfig(`
workspace:
  name: "Valid"
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
`);

    const { reloadConfig, validateConfig } = await freshImport();
    reloadConfig();

    const errors = validateConfig();
    expect(errors).toEqual([]);
  });

  test("missing workspace.name returns error", async () => {
    writeConfig(`
workspace: {}
repos: {}
budgets:
  per_task: 5
settings:
  max_concurrent: 4
  branch_prefix: "grove/"
  auto_sync: false
`);

    const { reloadConfig, validateConfig } = await freshImport();
    reloadConfig();

    const errors = validateConfig();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e: string) => e.includes("workspace.name"))).toBe(true);
  });

  test("missing budgets section returns error", async () => {
    writeConfig(`
workspace:
  name: "Test"
repos: {}
settings:
  max_concurrent: 4
  branch_prefix: "grove/"
  auto_sync: false
`);

    const { reloadConfig, validateConfig } = await freshImport();
    reloadConfig();

    const errors = validateConfig();
    expect(errors.some((e: string) => e.includes("budgets"))).toBe(true);
  });
});

describe("configRepos", () => {
  test("returns repo names from config", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, configRepos } = await freshImport();
    reloadConfig();

    const repos = configRepos();
    expect(repos).toContain("wheels");
    expect(repos).toContain("titan");
    expect(repos.length).toBe(2);
  });

  test("returns empty array when no repos", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, configRepos } = await freshImport();
    reloadConfig();

    expect(configRepos()).toEqual([]);
  });
});

describe("budgetGet", () => {
  test("returns numeric budget values", async () => {
    writeConfig(`
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
`);

    const { reloadConfig, budgetGet } = await freshImport();
    reloadConfig();

    expect(budgetGet("per_task")).toBe(5);
    expect(budgetGet("per_session")).toBe(10);
    expect(budgetGet("per_day")).toBe(25);
    expect(budgetGet("per_week")).toBe(100);
    expect(budgetGet("auto_approve_under")).toBe(2);
  });
});
