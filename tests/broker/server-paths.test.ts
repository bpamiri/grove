import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

const TEST_DIR = join(import.meta.dir, "test-config-paths");
process.env.GROVE_HOME = TEST_DIR;

const { reloadConfig, configPaths, configSetPath, configDeletePath } = await import("../../src/broker/config");
import { validatePathConfig } from "../../src/engine/normalize";

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "grove.yaml"), stringifyYaml({
    workspace: { name: "Test" },
    paths: {
      development: {
        description: "Standard dev workflow",
        steps: [
          { id: "implement", type: "worker", prompt: "Do the work" },
          { id: "review", type: "worker", sandbox: "read-only" },
        ],
      },
    },
  }));
  reloadConfig();
});

afterEach(() => {
  const p = join(TEST_DIR, "grove.yaml");
  if (existsSync(p)) unlinkSync(p);
  reloadConfig();
});

// ---------------------------------------------------------------------------
// configSetPath / configDeletePath
// ---------------------------------------------------------------------------

describe("configSetPath", () => {
  test("creates a new path", () => {
    configSetPath("custom", {
      description: "Custom workflow",
      steps: [{ id: "build", type: "worker", prompt: "Build it" }],
    });
    const paths = configPaths();
    expect(paths.custom).toBeDefined();
    expect(paths.custom.description).toBe("Custom workflow");
    expect(paths.custom.steps).toHaveLength(1);
  });

  test("overwrites an existing path", () => {
    configSetPath("development", {
      description: "Updated dev",
      steps: [{ id: "code", type: "worker", prompt: "Code it" }],
    });
    const paths = configPaths();
    expect(paths.development.description).toBe("Updated dev");
    expect(paths.development.steps).toHaveLength(1);
  });

  test("persists to YAML on disk", () => {
    configSetPath("persisted", {
      description: "Should survive reload",
      steps: [{ id: "work", type: "worker" }],
    });
    reloadConfig();
    const paths = configPaths();
    expect(paths.persisted).toBeDefined();
    expect(paths.persisted.description).toBe("Should survive reload");
  });
});

describe("configDeletePath", () => {
  test("removes an existing path", () => {
    configDeletePath("development");
    const paths = configPaths();
    expect(paths.development).toBeUndefined();
  });

  test("no-ops for nonexistent path", () => {
    configDeletePath("nonexistent");
    const paths = configPaths();
    expect(paths.development).toBeDefined();
  });

  test("persists deletion to disk", () => {
    configDeletePath("development");
    reloadConfig();
    const raw = readFileSync(join(TEST_DIR, "grove.yaml"), "utf-8");
    const parsed = parseYaml(raw) as any;
    expect(parsed.paths?.development).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validatePathConfig
// ---------------------------------------------------------------------------

describe("validatePathConfig", () => {
  test("accepts valid path config", () => {
    const errors = validatePathConfig({
      description: "Valid path",
      steps: [
        { id: "work", type: "worker", prompt: "Do it" },
        { id: "check", type: "verdict" },
      ],
    });
    expect(errors).toEqual([]);
  });

  test("rejects missing description", () => {
    const errors = validatePathConfig({ description: "", steps: [{ id: "a", type: "worker" }] });
    expect(errors).toContain("description is required");
  });

  test("rejects empty steps array", () => {
    const errors = validatePathConfig({ description: "No steps", steps: [] });
    expect(errors).toContain("at least one step is required");
  });

  test("rejects step without id", () => {
    const errors = validatePathConfig({ description: "Bad step", steps: [{ id: "", type: "worker" }] });
    expect(errors.some(e => e.includes("id"))).toBe(true);
  });

  test("rejects invalid step type", () => {
    const errors = validatePathConfig({ description: "Bad type", steps: [{ id: "x", type: "bogus" }] });
    expect(errors.some(e => e.includes("type"))).toBe(true);
  });

  test("rejects duplicate step ids", () => {
    const errors = validatePathConfig({
      description: "Dupes",
      steps: [
        { id: "work", type: "worker" },
        { id: "work", type: "worker" },
      ],
    });
    expect(errors.some(e => e.includes("duplicate"))).toBe(true);
  });

  test("rejects on_success referencing nonexistent step", () => {
    const errors = validatePathConfig({
      description: "Bad ref",
      steps: [{ id: "a", type: "worker", on_success: "nonexistent" }],
    });
    expect(errors.some(e => e.includes("on_success"))).toBe(true);
  });

  test("allows $done and $fail as on_success/on_failure targets", () => {
    const errors = validatePathConfig({
      description: "Terminals",
      steps: [{ id: "a", type: "worker", on_success: "$done", on_failure: "$fail" }],
    });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path API endpoint logic (integration-level)
// ---------------------------------------------------------------------------

describe("Path API endpoint logic", () => {
  test("POST /api/paths — validates and saves new path", () => {
    const body = {
      description: "API-created path",
      steps: [{ id: "work", type: "worker", prompt: "Do the thing" }],
    };
    const errors = validatePathConfig(body);
    expect(errors).toEqual([]);
    configSetPath("api-path", body);
    const paths = configPaths();
    expect(paths["api-path"]).toBeDefined();
    expect(paths["api-path"].description).toBe("API-created path");
  });

  test("POST /api/paths — rejects invalid config", () => {
    const body = { description: "", steps: [] };
    const errors = validatePathConfig(body);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("PUT /api/paths/:name — updates existing path", () => {
    const updated = {
      description: "Updated dev",
      steps: [{ id: "code", type: "worker", prompt: "Write code" }],
    };
    configSetPath("development", updated);
    reloadConfig();
    const paths = configPaths();
    expect(paths.development.description).toBe("Updated dev");
  });

  test("DELETE /api/paths/:name — removes path from config", () => {
    configSetPath("temp-path", { description: "Temp", steps: [{ id: "a", type: "worker" }] });
    configDeletePath("temp-path");
    reloadConfig();
    const raw = readFileSync(join(TEST_DIR, "grove.yaml"), "utf-8");
    const parsed = parseYaml(raw) as any;
    expect(parsed.paths?.["temp-path"]).toBeUndefined();
  });
});
