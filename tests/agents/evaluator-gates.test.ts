// Grove v3 — Evaluator quality-gate unit tests (real git repos)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { evaluate, buildRetryPrompt } from "../../src/agents/evaluator";
import { createFixtureTree, createFixtureTask, cleanupDir } from "../fixtures/helpers";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../src/broker/db";
import { bus } from "../../src/broker/event-bus";

let db: Database;
let repoPath: string;
let treeId: string;

function setupWorktree(repoPath: string, taskId: string): string {
  const branch = `grove/${taskId}-test`;
  const wtPath = join(repoPath, ".grove", "worktrees", taskId);
  Bun.spawnSync(["mkdir", "-p", join(repoPath, ".grove", "worktrees")]);
  Bun.spawnSync(["git", "-C", repoPath, "worktree", "add", "-b", branch, wtPath, "HEAD"]);
  return wtPath;
}

beforeEach(() => {
  const fixture = createFixtureTree();
  db = fixture.db;
  repoPath = fixture.repoPath;
  treeId = fixture.treeId;
});

afterEach(() => {
  bus.removeAll();
  db.close();
  cleanupDir(repoPath);
});

// ---------------------------------------------------------------------------
// commits gate
// ---------------------------------------------------------------------------

describe("commits gate", () => {
  test("fails when no commits on branch", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(repoPath, taskId);
    const branch = `grove/${taskId}-test`;
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, branch, taskId]);

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    expect(result.passed).toBe(false);
    const commitsGate = result.gateResults.find(g => g.gate === "commits");
    expect(commitsGate).toBeDefined();
    expect(commitsGate!.passed).toBe(false);
    expect(commitsGate!.tier).toBe("hard");
  });

  test("passes when commits exist", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(repoPath, taskId);
    const branch = `grove/${taskId}-test`;
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, branch, taskId]);

    // Add a file and commit in the worktree
    writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: wtPath });
    Bun.spawnSync(["git", "commit", "-m", "feat: add feature"], {
      cwd: wtPath,
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_EMAIL: "t@t" },
    });

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    const commitsGate = result.gateResults.find(g => g.gate === "commits");
    expect(commitsGate).toBeDefined();
    expect(commitsGate!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// diff_size gate
// ---------------------------------------------------------------------------

describe("diff_size gate", () => {
  test("passes within default bounds", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(repoPath, taskId);
    const branch = `grove/${taskId}-test`;
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, branch, taskId]);

    // Small change
    writeFileSync(join(wtPath, "small.ts"), "export const y = 2;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: wtPath });
    Bun.spawnSync(["git", "commit", "-m", "feat: small change"], {
      cwd: wtPath,
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_EMAIL: "t@t" },
    });

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    const diffGate = result.gateResults.find(g => g.gate === "diff_size");
    expect(diffGate).toBeDefined();
    expect(diffGate!.passed).toBe(true);
    expect(diffGate!.tier).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// worktree missing
// ---------------------------------------------------------------------------

describe("worktree missing", () => {
  test("fails gracefully", () => {
    const taskId = createFixtureTask(db, treeId, {
      status: "active",
      worktreePath: "/nonexistent/path",
    });

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Worktree not found");
  });
});

// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------

describe("buildRetryPrompt", () => {
  test("includes failure details", () => {
    const gates = [
      { gate: "tests", passed: false, tier: "hard" as const, message: "Tests failed (exit 1)", output: "FAIL src/app.test.ts\nExpected 1, got 2" },
      { gate: "commits", passed: true, tier: "hard" as const, message: "1 commit on branch" },
    ];
    const prompt = buildRetryPrompt(gates);

    expect(prompt).toContain("tests: FAILED");
    expect(prompt).toContain("Tests failed (exit 1)");
    expect(prompt).toContain("FAIL src/app.test.ts");
  });

  test("includes seed spec", () => {
    const gates = [
      { gate: "tests", passed: false, tier: "hard" as const, message: "Tests failed (exit 1)" },
    ];
    const seedSpec = "Build a REST API with /users endpoint";
    const prompt = buildRetryPrompt(gates, seedSpec);

    expect(prompt).toContain("Seed");
    expect(prompt).toContain(seedSpec);
  });

  test("returns empty for all-passing gates", () => {
    const gates = [
      { gate: "commits", passed: true, tier: "hard" as const, message: "1 commit on branch" },
      { gate: "diff_size", passed: true, tier: "soft" as const, message: "42 lines changed" },
    ];
    const prompt = buildRetryPrompt(gates);

    expect(prompt).toBe("");
  });
});
