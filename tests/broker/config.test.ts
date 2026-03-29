import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";

// Override GROVE_HOME before importing config
const TEST_DIR = join(import.meta.dir, "test-config");
process.env.GROVE_HOME = TEST_DIR;

// Dynamic import to pick up the env override
const { loadConfig, reloadConfig, configGet, configSet, validateConfig, configTrees, configPaths, budgetGet, workspaceName, writeDefaultConfig } = await import("../../src/broker/config");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up test files
  for (const f of ["grove.yaml"]) {
    const path = join(TEST_DIR, f);
    if (existsSync(path)) unlinkSync(path);
  }
  if (existsSync(TEST_DIR)) {
    try { unlinkSync(TEST_DIR); } catch {}
  }
  reloadConfig();
});

describe("Config loading", () => {
  test("returns defaults when no config file exists", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    if (existsSync(configPath)) unlinkSync(configPath);
    reloadConfig();

    const config = loadConfig();
    expect(config.workspace.name).toBe("Grove");
    expect(config.settings.max_workers).toBe(5);
    expect(config.server.port).toBe("auto");
    expect(config.tunnel.provider).toBe("cloudflare");
  });

  test("loads and merges with defaults", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "My Workspace" },
      trees: {
        "api-server": { path: "/code/api", github: "org/api" },
      },
      settings: { max_workers: 10 },
    }));
    reloadConfig();

    const config = loadConfig();
    expect(config.workspace.name).toBe("My Workspace");
    expect(config.settings.max_workers).toBe(10);
    // Defaults still present
    expect(config.settings.branch_prefix).toBe("grove/");
    expect(config.budgets.per_task).toBe(5.0);
    expect(config.tunnel.provider).toBe("cloudflare");
  });

  test("includes default paths when not overridden", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
    }));
    reloadConfig();

    const paths = configPaths();
    expect(paths.development).toBeDefined();
    expect(paths.development.steps.map((s: any) => typeof s === "string" ? s : s.id)).toEqual(["plan", "implement", "evaluate", "merge"]);
    expect(paths.research).toBeDefined();
    expect(paths.content).toBeDefined();
  });

  test("user paths merge with defaults", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
      paths: {
        custom: { description: "Custom workflow", steps: ["plan", "implement"] },
      },
    }));
    reloadConfig();

    const paths = configPaths();
    expect(paths.development).toBeDefined(); // default still present
    expect(paths.custom).toBeDefined();
    expect(paths.custom.steps).toEqual(["plan", "implement"]);
  });
});

describe("Dot-notation access", () => {
  test("configGet reads nested values", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
      budgets: { per_task: 3.0 },
    }));
    reloadConfig();

    expect(configGet("workspace.name")).toBe("Test");
    expect(configGet("budgets.per_task")).toBe(3.0);
    expect(configGet("nonexistent.key")).toBeUndefined();
  });

  test("configSet writes and persists", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
    }));
    reloadConfig();

    configSet("workspace.name", "Updated");
    expect(configGet("workspace.name")).toBe("Updated");

    // Verify persisted to disk
    reloadConfig();
    expect(configGet("workspace.name")).toBe("Updated");
  });

  test("configSet coerces types", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({ workspace: { name: "Test" } }));
    reloadConfig();

    configSet("settings.max_workers", "10");
    expect(configGet("settings.max_workers")).toBe(10);

    configSet("settings.auto_sync", "true");
    expect(configGet("settings.auto_sync")).toBe(true);
  });
});

describe("Validation", () => {
  test("empty config has no errors (defaults fill in)", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({}));
    reloadConfig();

    const errors = validateConfig();
    expect(errors.length).toBe(0); // defaults provide workspace.name
  });

  test("validates tree paths", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
      trees: { "bad-tree": {} },
    }));
    reloadConfig();

    const errors = validateConfig();
    expect(errors.some(e => e.includes("bad-tree"))).toBe(true);
  });
});

describe("Helper functions", () => {
  test("configTrees returns tree map", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({
      workspace: { name: "Test" },
      trees: {
        api: { path: "/api", github: "org/api" },
        web: { path: "/web" },
      },
    }));
    reloadConfig();

    const trees = configTrees();
    expect(Object.keys(trees)).toEqual(["api", "web"]);
    expect(trees.api.github).toBe("org/api");
  });

  test("budgetGet returns configured or default value", () => {
    reloadConfig();
    expect(budgetGet("per_task")).toBe(5.0);
    expect(budgetGet("per_week")).toBe(100.0);
  });

  test("workspaceName returns configured name", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeFileSync(configPath, stringifyYaml({ workspace: { name: "PAI" } }));
    reloadConfig();
    expect(workspaceName()).toBe("PAI");
  });

  test("writeDefaultConfig creates valid YAML", () => {
    const configPath = join(TEST_DIR, "grove.yaml");
    writeDefaultConfig(configPath);
    reloadConfig();

    const config = loadConfig();
    expect(config.workspace.name).toBe("Grove");
    expect(config.paths.development).toBeDefined();
    expect(config.budgets.per_task).toBe(5.0);
  });
});
