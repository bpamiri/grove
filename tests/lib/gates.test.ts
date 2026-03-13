import { describe, test, expect } from "bun:test";
import { resolveGateConfig, DEFAULT_GATE_CONFIG } from "../../src/lib/gates";

describe("resolveGateConfig", () => {
  test("returns defaults when no overrides", () => {
    const config = resolveGateConfig(undefined, undefined);
    expect(config).toEqual(DEFAULT_GATE_CONFIG);
  });

  test("global overrides change defaults", () => {
    const config = resolveGateConfig({ lint: true, max_diff_lines: 10000 }, undefined);
    expect(config.lint).toBe(true);
    expect(config.max_diff_lines).toBe(10000);
    expect(config.commits).toBe(true);
  });

  test("repo overrides take precedence over global", () => {
    const config = resolveGateConfig({ tests: true, lint: true }, { tests: false });
    expect(config.tests).toBe(false);
    expect(config.lint).toBe(true);
  });

  test("repo overrides work without global", () => {
    const config = resolveGateConfig(undefined, { lint: true });
    expect(config.lint).toBe(true);
    expect(config.commits).toBe(true);
  });
});
