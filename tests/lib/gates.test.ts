import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGateConfig,
  DEFAULT_GATE_CONFIG,
  checkCommits,
  checkDiffSize,
  checkTests,
  checkLint,
} from "../../src/lib/gates";

// ---------------------------------------------------------------------------
// Config resolution tests
// ---------------------------------------------------------------------------

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

  test("repo can disable a default-true gate", () => {
    const config = resolveGateConfig(undefined, { tests: false });
    expect(config.tests).toBe(false);
    expect(config.commits).toBe(true);
    expect(config.diff_size).toBe(true);
  });

  test("explicit undefined values do not override defaults", () => {
    const config = resolveGateConfig(undefined, { commits: undefined });
    expect(config.commits).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Git repo helpers for gate check tests
// ---------------------------------------------------------------------------

let tempDir: string | null = null;

function setupGitWorktree(): string {
  tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
  Bun.spawnSync(["git", "init"], { cwd: tempDir });
  Bun.spawnSync(["git", "checkout", "-b", "main"], { cwd: tempDir });
  writeFileSync(join(tempDir, "README.md"), "init");
  Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: tempDir });
  Bun.spawnSync(["git", "checkout", "-b", "grove/T-001-test"], { cwd: tempDir });
  return tempDir;
}

function setupTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// checkCommits
// ---------------------------------------------------------------------------

describe("checkCommits", () => {
  test("fails when no commits on branch", () => {
    const dir = setupGitWorktree();
    const result = checkCommits(dir);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("hard");
    expect(result.gate).toBe("commits");
    expect(result.message).toBe("No commits found");
  });

  test("passes when commits exist", () => {
    const dir = setupGitWorktree();
    writeFileSync(join(dir, "new-file.ts"), "export const x = 1;");
    Bun.spawnSync(["git", "add", "."], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-m", "add new file"], { cwd: dir });
    const result = checkCommits(dir);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("hard");
    expect(result.gate).toBe("commits");
    expect(result.message).toContain("1 commit");
  });
});

// ---------------------------------------------------------------------------
// checkDiffSize
// ---------------------------------------------------------------------------

describe("checkDiffSize", () => {
  test("passes when diff within range", () => {
    const dir = setupGitWorktree();
    writeFileSync(join(dir, "file.ts"), "const a = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-m", "add file"], { cwd: dir });
    const result = checkDiffSize(dir, 1, 5000);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("soft");
    expect(result.gate).toBe("diff_size");
    expect(result.message).toContain("within range");
  });

  test("fails when diff too large", () => {
    const dir = setupGitWorktree();
    const bigContent = Array(100).fill("const x = 1;").join("\n");
    writeFileSync(join(dir, "big.ts"), bigContent);
    Bun.spawnSync(["git", "add", "."], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-m", "add big file"], { cwd: dir });
    const result = checkDiffSize(dir, 1, 10);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("exceeds max");
  });

  test("fails when diff empty", () => {
    const dir = setupGitWorktree();
    // No commits on branch → 0 lines changed
    const result = checkDiffSize(dir, 1, 5000);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("below min");
  });
});

// ---------------------------------------------------------------------------
// checkTests
// ---------------------------------------------------------------------------

describe("checkTests", () => {
  test("auto-passes when no test runner", () => {
    const dir = setupTempDir();
    const result = checkTests(dir, 30);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("tests");
    expect(result.message).toContain("No test runner");
  });

  test("passes when tests succeed", () => {
    const dir = setupTempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "true" } }),
    );
    const result = checkTests(dir, 30);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("tests");
    expect(result.message).toBe("Tests passed");
  });

  test("fails when tests fail", () => {
    const dir = setupTempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
    );
    const result = checkTests(dir, 30);
    expect(result.passed).toBe(false);
    expect(result.gate).toBe("tests");
    expect(result.message).toMatch(/Tests failed \(exit \d+\)/);
  });
});

// ---------------------------------------------------------------------------
// checkLint
// ---------------------------------------------------------------------------

describe("checkLint", () => {
  test("auto-passes when no linter detected", () => {
    const dir = setupTempDir();
    const result = checkLint(dir, 30);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe("lint");
    expect(result.message).toContain("No linter");
  });
});
