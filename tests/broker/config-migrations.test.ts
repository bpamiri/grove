import { describe, test, expect } from "bun:test";
import {
  migrateConfig,
  latestVersion,
  detectVersion,
} from "../../src/broker/config-migrations";

describe("detectVersion", () => {
  test("returns 1 for config without version field", () => {
    expect(detectVersion({ workspace: { name: "test" } })).toBe(1);
  });
  test("returns version field when present", () => {
    expect(detectVersion({ version: 2, workspace: { name: "test" } })).toBe(2);
  });
  test("returns 1 for null/undefined", () => {
    expect(detectVersion(null)).toBe(1);
    expect(detectVersion(undefined)).toBe(1);
  });
});

describe("latestVersion", () => {
  test("returns a number >= 2", () => {
    expect(latestVersion()).toBeGreaterThanOrEqual(2);
  });
});

describe("migrateConfig", () => {
  test("migrates v1 config to latest", () => {
    const v1 = {
      workspace: { name: "Test" },
      trees: {},
      paths: {},
      budgets: {
        per_task: 5,
        per_session: 10,
        per_day: 25,
        per_week: 100,
        auto_approve_under: 2,
      },
      server: { port: "auto" },
      tunnel: { provider: "cloudflare", auth: "token" },
      settings: {
        max_workers: 5,
        branch_prefix: "grove/",
        stall_timeout_minutes: 5,
        max_retries: 2,
      },
    };
    const { config, applied } = migrateConfig(v1);
    expect(config.version).toBe(latestVersion());
    expect(applied.length).toBeGreaterThan(0);
    expect(config.settings.default_adapter).toBe("claude-code");
  });
  test("returns empty applied for already-latest config", () => {
    const latest = {
      version: latestVersion(),
      workspace: { name: "Test" },
      settings: { default_adapter: "claude-code" },
    };
    const { config, applied } = migrateConfig(latest);
    expect(applied.length).toBe(0);
    expect(config.version).toBe(latestVersion());
  });
  test("preserves user values during migration", () => {
    const v1 = {
      workspace: { name: "My Grove" },
      settings: {
        max_workers: 10,
        branch_prefix: "custom/",
        stall_timeout_minutes: 15,
        max_retries: 3,
      },
    };
    const { config } = migrateConfig(v1);
    expect(config.workspace.name).toBe("My Grove");
    expect(config.settings.max_workers).toBe(10);
    expect(config.settings.branch_prefix).toBe("custom/");
  });
});
