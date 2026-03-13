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
  runGates,
  buildGateFixPrompt,
} from "../../src/lib/gates";
import type { GateConfig, GateResult } from "../../src/types";

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

// ---------------------------------------------------------------------------
// runGates
// ---------------------------------------------------------------------------

describe("runGates", () => {
  test("returns all enabled gate results", () => {
    const dir = setupGitWorktree();
    writeFileSync(join(dir, "file.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-m", "add file"], { cwd: dir });

    const config: GateConfig = {
      ...DEFAULT_GATE_CONFIG,
      lint: false, // disable lint
    };
    const results = runGates(dir, config);
    expect(results.length).toBe(3); // commits, tests, diff_size
    const gates = results.map(r => r.gate);
    expect(gates).toContain("commits");
    expect(gates).toContain("tests");
    expect(gates).toContain("diff_size");
    const commits = results.find(r => r.gate === "commits")!;
    expect(commits.passed).toBe(true);
  });

  test("skips disabled gates", () => {
    const dir = setupGitWorktree();
    const config: GateConfig = {
      commits: false,
      tests: false,
      lint: false,
      diff_size: false,
      min_diff_lines: 1,
      max_diff_lines: 5000,
      test_timeout: 60,
      lint_timeout: 30,
    };
    const results = runGates(dir, config);
    expect(results.length).toBe(0);
  });

  test("reports hard and soft failures separately", () => {
    const dir = setupGitWorktree();
    // No commits on branch → commits = hard fail, diff_size = soft fail (below min)
    const config: GateConfig = {
      commits: true,
      tests: false,
      lint: false,
      diff_size: true,
      min_diff_lines: 1,
      max_diff_lines: 5000,
      test_timeout: 60,
      lint_timeout: 30,
    };
    const results = runGates(dir, config);
    const commits = results.find(r => r.gate === "commits")!;
    expect(commits.passed).toBe(false);
    expect(commits.tier).toBe("hard");
    const diffSize = results.find(r => r.gate === "diff_size")!;
    expect(diffSize.passed).toBe(false);
    expect(diffSize.tier).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// buildGateFixPrompt
// ---------------------------------------------------------------------------

describe("buildGateFixPrompt", () => {
  test("builds prompt from failed gates", () => {
    const results: GateResult[] = [
      { gate: "commits", passed: true, tier: "hard", message: "1 commit on branch" },
      { gate: "tests", passed: false, tier: "hard", message: "Tests failed (exit 1)" },
      { gate: "diff_size", passed: false, tier: "soft", message: "Diff 0 lines below min (1..5000)" },
    ];
    const prompt = buildGateFixPrompt(results);
    expect(prompt).toContain("tests");
    expect(prompt).toContain("FAILED");
    expect(prompt).toContain("diff_size");
    expect(prompt).not.toContain("commits");
  });

  test("returns empty string when all pass", () => {
    const results: GateResult[] = [
      { gate: "commits", passed: true, tier: "hard", message: "1 commit" },
      { gate: "tests", passed: true, tier: "hard", message: "Tests passed" },
    ];
    const prompt = buildGateFixPrompt(results);
    expect(prompt).toBe("");
  });

  test("includes output in prompt when present", () => {
    const results: GateResult[] = [
      {
        gate: "tests",
        passed: false,
        tier: "hard",
        message: "Tests failed (exit 1)",
        output: "FAIL src/index.test.ts\nExpected 2 but received 3",
      },
    ];
    const prompt = buildGateFixPrompt(results);
    expect(prompt).toContain("FAIL src/index.test.ts");
    expect(prompt).toContain("Expected 2 but received 3");
  });
});
