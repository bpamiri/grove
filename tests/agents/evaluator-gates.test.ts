import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, createFixtureRepo } from "../fixtures/helpers";
import {
  capOutput,
  parseBaseRefFromConfig,
  resolveBaseRef,
  resolveGateConfig,
  checkCommits,
  checkTests,
  checkLint,
  checkDiffSize,
  runGates,
  evaluate,
  buildRetryPrompt,
  MAX_REBASE_FAILURES,
} from "../../src/agents/evaluator";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";
import type { Task, Tree } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// capOutput
// ---------------------------------------------------------------------------

describe("capOutput", () => {
  test("returns string as-is when under 5KB limit", () => {
    const buf = Buffer.from("short output");
    expect(capOutput(buf)).toBe("short output");
  });

  test("returns string as-is when exactly at limit", () => {
    const str = "x".repeat(5000);
    const buf = Buffer.from(str);
    expect(capOutput(buf)).toBe(str);
  });

  test("truncates with suffix when over limit", () => {
    const str = "x".repeat(10000);
    const buf = Buffer.from(str);
    const result = capOutput(buf);
    expect(result.length).toBeLessThan(str.length);
    expect(result).toContain("[... truncated]");
    expect(result.startsWith("x".repeat(5000))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseBaseRefFromConfig
// ---------------------------------------------------------------------------

describe("parseBaseRefFromConfig", () => {
  test("returns undefined for null config", () => {
    expect(parseBaseRefFromConfig(null)).toBeUndefined();
  });

  test("returns base_ref from quality_gates", () => {
    const config = JSON.stringify({ quality_gates: { base_ref: "origin/develop" } });
    expect(parseBaseRefFromConfig(config)).toBe("origin/develop");
  });

  test("returns origin/{branch} from default_branch", () => {
    const config = JSON.stringify({ default_branch: "develop" });
    expect(parseBaseRefFromConfig(config)).toBe("origin/develop");
  });

  test("returns undefined for invalid JSON", () => {
    expect(parseBaseRefFromConfig("not json {{{")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveGateConfig
// ---------------------------------------------------------------------------

describe("resolveGateConfig", () => {
  test("returns defaults for null config", () => {
    const config = resolveGateConfig(null);
    expect(config.commits).toBe(true);
    expect(config.tests).toBe(true);
    expect(config.lint).toBe(false);
    expect(config.diff_size).toBe(true);
  });

  test("merges partial overrides with defaults", () => {
    const config = resolveGateConfig(JSON.stringify({ lint: true, test_timeout: 120 }));
    expect(config.lint).toBe(true);
    expect(config.test_timeout).toBe(120);
    expect(config.commits).toBe(true); // from defaults
  });

  test("extracts from quality_gates nested key", () => {
    const config = resolveGateConfig(JSON.stringify({
      quality_gates: { lint: true, base_ref: "origin/develop" },
      default_branch: "develop",
    }));
    expect(config.lint).toBe(true);
    expect(config.base_ref).toBe("origin/develop");
  });
});

// ---------------------------------------------------------------------------
// resolveBaseRef (requires git repo)
// ---------------------------------------------------------------------------

describe("resolveBaseRef", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("returns config ref when provided", () => {
    expect(resolveBaseRef(repoPath, "origin/develop")).toBe("origin/develop");
  });

  test("detects main branch when it exists", () => {
    // Our fixture repo uses "main" as default branch
    const ref = resolveBaseRef(repoPath);
    expect(ref).toBe("main");
  });

  test("falls back to origin/main when no recognized branch exists", () => {
    // Create a repo with a non-standard branch name
    const weird = createFixtureRepo();
    Bun.spawnSync(["git", "checkout", "-b", "trunk"], { cwd: weird.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "branch", "-D", "main"], { cwd: weird.repoPath, stdin: "ignore" });
    const ref = resolveBaseRef(weird.repoPath);
    expect(ref).toBe("origin/main"); // fallback
    weird.cleanup();
  });
});

// ---------------------------------------------------------------------------
// checkCommits (requires git repo with branch)
// ---------------------------------------------------------------------------

describe("checkCommits", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo({ branch: "feature/test" });
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("passes when branch has commits ahead of base", () => {
    // Add a commit on the feature branch
    writeFileSync(join(repoPath, "new-file.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add feature"], { cwd: repoPath, stdin: "ignore" });

    const result = checkCommits(repoPath, "main");
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("hard");
    expect(result.message).toContain("commit");
  });

  test("fails when branch has no commits ahead of base", () => {
    // Create a fresh repo where the branch is at the same point as main
    const fresh = createFixtureRepo({ branch: "empty-branch" });
    const result = checkCommits(fresh.repoPath, "main");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("hard");
    expect(result.message).toBe("No commits found");
    fresh.cleanup();
  });
});

// ---------------------------------------------------------------------------
// checkDiffSize (requires git repo with changes)
// ---------------------------------------------------------------------------

describe("checkDiffSize", () => {
  test("fails when diff is below minimum", () => {
    const repo = createFixtureRepo({ branch: "no-changes" });
    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("below min");
    repo.cleanup();
  });

  test("passes when diff is within range", () => {
    const repo = createFixtureRepo({ branch: "some-changes" });
    writeFileSync(join(repo.repoPath, "feature.ts"), Array(10).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add feature"], { cwd: repo.repoPath, stdin: "ignore" });

    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("lines changed");
    repo.cleanup();
  });

  test("fails when diff exceeds maximum", () => {
    const repo = createFixtureRepo({ branch: "big-changes" });
    writeFileSync(join(repo.repoPath, "big.ts"), Array(100).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add big file"], { cwd: repo.repoPath, stdin: "ignore" });

    const result = checkDiffSize(repo.repoPath, 1, 10, "main"); // max=10
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("exceeds max");
    repo.cleanup();
  });

  test("zero diff fails min check", () => {
    const repo = createFixtureRepo({ branch: "zero-diff" });
    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(false);
    repo.cleanup();
  });
});

// ---------------------------------------------------------------------------
// checkTests
// ---------------------------------------------------------------------------

describe("checkTests", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("skips when no test command configured", () => {
    const result = checkTests(repoPath, 60, undefined);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skipped");
  });

  test("passes when test command succeeds", () => {
    const result = checkTests(repoPath, 60, "true");
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Tests passed");
  });

  test("fails when test command fails", () => {
    const result = checkTests(repoPath, 60, "echo 'FAIL: assertion error' >&2 && false");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Tests failed");
    expect(result.output).toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// checkLint
// ---------------------------------------------------------------------------

describe("checkLint", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("skips when no lint command configured", () => {
    const result = checkLint(repoPath, 30, undefined);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("skipped");
  });

  test("passes when lint command succeeds", () => {
    const result = checkLint(repoPath, 30, "true");
    expect(result.passed).toBe(true);
  });

  test("fails when lint command fails", () => {
    const result = checkLint(repoPath, 30, "echo 'lint error: no-unused-vars' >&2 && false");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.output).toContain("lint error");
  });
});

// ---------------------------------------------------------------------------
// runGates
// ---------------------------------------------------------------------------

describe("runGates", () => {
  test("runs all enabled gates", () => {
    const repo = createFixtureRepo({ branch: "all-gates" });
    writeFileSync(join(repo.repoPath, "x.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat"], { cwd: repo.repoPath, stdin: "ignore" });

    const results = runGates(repo.repoPath, {
      commits: true, tests: true, lint: false, diff_size: true,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });

    expect(results.length).toBe(3); // commits, tests (skipped — no cmd), diff_size
    expect(results.map(r => r.gate)).toEqual(["commits", "tests", "diff_size"]);
    repo.cleanup();
  });

  test("skips disabled gates", () => {
    const repo = createFixtureRepo();
    const results = runGates(repo.repoPath, {
      commits: false, tests: false, lint: false, diff_size: false,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });
    expect(results.length).toBe(0);
    repo.cleanup();
  });

  test("includes both hard and soft failures in results", () => {
    const repo = createFixtureRepo({ branch: "empty-branch" });
    const results = runGates(repo.repoPath, {
      commits: true, tests: false, lint: false, diff_size: true,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });
    const commitResult = results.find(r => r.gate === "commits");
    const diffResult = results.find(r => r.gate === "diff_size");
    expect(commitResult!.passed).toBe(false);
    expect(commitResult!.tier).toBe("hard");
    expect(diffResult!.passed).toBe(false);
    expect(diffResult!.tier).toBe("soft");
    repo.cleanup();
  });
});

// ---------------------------------------------------------------------------
// evaluate (integration — needs DB + git repo)
// ---------------------------------------------------------------------------

describe("evaluate", () => {
  let db: Database;
  let dbCleanup: () => void;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    dbCleanup = result.cleanup;
    db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  });

  afterEach(() => {
    bus.removeAll("eval:started");
    bus.removeAll("eval:passed");
    bus.removeAll("eval:failed");
    bus.removeAll("gate:result");
    dbCleanup();
  });

  test("returns failure when worktree path does not exist", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "/tmp/does-not-exist-ever"],
    );
    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Worktree not found");
    expect(result.gateResults).toEqual([]);
  });

  test("returns passed when all gates pass", () => {
    const repo = createFixtureRepo({ branch: "work" });
    writeFileSync(join(repo.repoPath, "feature.ts"), "export const a = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat: add feature"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All gates passed");
    repo.cleanup();
  });

  test("returns failure when hard gate fails", () => {
    const repo = createFixtureRepo({ branch: "empty" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.gateResults.some(g => g.gate === "commits" && !g.passed)).toBe(true);
    repo.cleanup();
  });

  test("passes when only soft gates fail", () => {
    const repo = createFixtureRepo({ branch: "soft-fail" });
    writeFileSync(join(repo.repoPath, "big.ts"), Array(200).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat: big change"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: JSON.stringify({ max_diff_lines: 10 }) });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(true); // soft failures don't block
    expect(result.gateResults.some(g => g.gate === "diff_size" && !g.passed)).toBe(true);
    repo.cleanup();
  });

  test("stores gate results on task row", () => {
    const repo = createFixtureRepo({ branch: "store-test" });
    writeFileSync(join(repo.repoPath, "f.ts"), "export const a = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    evaluate(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.gate_results).not.toBeNull();
    const stored = JSON.parse(updated.gate_results!);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBeGreaterThan(0);
    repo.cleanup();
  });
});

// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------

describe("buildRetryPrompt", () => {
  test("returns empty string when no failures", () => {
    expect(buildRetryPrompt([])).toBe("");
    expect(buildRetryPrompt([
      { gate: "commits", passed: true, tier: "hard", message: "1 commit" },
    ])).toBe("");
  });

  test("includes gate names and messages for failures", () => {
    const prompt = buildRetryPrompt([
      { gate: "commits", passed: false, tier: "hard", message: "No commits found" },
      { gate: "tests", passed: false, tier: "hard", message: "Tests failed (exit 1)", output: "FAIL: auth.test.ts" },
    ]);
    expect(prompt).toContain("commits: FAILED");
    expect(prompt).toContain("No commits found");
    expect(prompt).toContain("tests: FAILED");
    expect(prompt).toContain("FAIL: auth.test.ts");
    expect(prompt).toContain("Fix these issues");
  });

  test("appends seed spec when provided", () => {
    const prompt = buildRetryPrompt(
      [{ gate: "tests", passed: false, tier: "hard", message: "Tests failed (exit 1)" }],
      "Build a REST API with CRUD endpoints",
    );
    expect(prompt).toContain("Seed (Design Spec)");
    expect(prompt).toContain("Build a REST API with CRUD endpoints");
  });
});

// ---------------------------------------------------------------------------
// Rebase conflict loop detection (W-030)
// ---------------------------------------------------------------------------

/**
 * Create two repos that will produce a rebase conflict:
 * - An "origin" repo with a commit on main that conflicts
 * - A "worktree" clone on a feature branch with conflicting changes
 */
function createConflictingRepos(): { worktreePath: string; cleanup: () => void } {
  // Create "origin" repo
  const origin = createFixtureRepo();

  // Clone it to create the "worktree" with a real remote
  const worktreePath = join(tmpdir(), `grove-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["git", "clone", origin.repoPath, worktreePath], { stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: worktreePath, stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: worktreePath, stdin: "ignore" });

  // Create feature branch in worktree with conflicting change
  Bun.spawnSync(["git", "checkout", "-b", "feature/conflict-test"], { cwd: worktreePath, stdin: "ignore" });
  writeFileSync(join(worktreePath, "README.md"), "# Feature\nConflicting line from feature branch\n");
  Bun.spawnSync(["git", "add", "."], { cwd: worktreePath, stdin: "ignore" });
  Bun.spawnSync(["git", "commit", "-m", "feat: conflicting change"], { cwd: worktreePath, stdin: "ignore" });

  // Push a conflicting change to origin's main
  writeFileSync(join(origin.repoPath, "README.md"), "# Main\nConflicting line from main branch\n");
  Bun.spawnSync(["git", "add", "."], { cwd: origin.repoPath, stdin: "ignore" });
  Bun.spawnSync(["git", "commit", "-m", "chore: main diverges"], { cwd: origin.repoPath, stdin: "ignore" });

  return {
    worktreePath,
    cleanup: () => {
      origin.cleanup();
      rmSync(worktreePath, { recursive: true, force: true });
    },
  };
}

describe("rebase conflict loop detection", () => {
  let db: Database;
  let dbCleanup: () => void;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    dbCleanup = result.cleanup;
    db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  });

  afterEach(() => {
    bus.removeAll("eval:started");
    bus.removeAll("eval:passed");
    bus.removeAll("eval:failed");
    bus.removeAll("gate:result");
    dbCleanup();
  });

  test("exports MAX_REBASE_FAILURES constant", () => {
    expect(MAX_REBASE_FAILURES).toBe(3);
  });

  test("first rebase failure is not fatal", () => {
    const repos = createConflictingRepos();

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repos.worktreePath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repos.worktreePath, config: "{}" });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.fatal).not.toBe(true);
    expect(result.gateResults[0].gate).toBe("rebase");
    repos.cleanup();
  });

  test("rebase failure becomes fatal after MAX_REBASE_FAILURES consecutive failures", () => {
    const repos = createConflictingRepos();

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repos.worktreePath],
    );
    db.treeUpsert({ id: "t1", name: "Test", path: repos.worktreePath, config: "{}" });

    // Simulate MAX_REBASE_FAILURES - 1 previous rebase failures in event history
    for (let i = 0; i < MAX_REBASE_FAILURES - 1; i++) {
      db.addEvent("W-001", null, "eval_failed", "Rebase failed: Merge conflicts with origin/main — rebase aborted");
    }

    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.feedback).toContain("manual resolution");
    repos.cleanup();
  });

  test("non-rebase eval failures do not count toward rebase failure limit", () => {
    const repos = createConflictingRepos();

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repos.worktreePath],
    );
    db.treeUpsert({ id: "t1", name: "Test", path: repos.worktreePath, config: "{}" });

    // Add non-rebase eval failures — these should NOT count
    for (let i = 0; i < 5; i++) {
      db.addEvent("W-001", null, "eval_failed", "Evaluation failed: 1 hard failures");
    }

    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.fatal).not.toBe(true); // only 1st rebase failure, non-rebase failures ignored
    repos.cleanup();
  });
});
