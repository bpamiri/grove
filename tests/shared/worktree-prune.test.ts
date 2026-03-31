import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { pruneStaleWorktrees } from "../../src/shared/worktree";
import { join } from "node:path";
import { mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-prune.db");
const TEST_REPO = join(import.meta.dir, "test-repo");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);

  rmSync(join(TEST_REPO, ".grove", "worktrees"), { recursive: true, force: true });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
  rmSync(join(TEST_REPO, ".grove", "worktrees"), { recursive: true, force: true });
});

function createFakeWorktree(taskId: string): string {
  const dir = join(TEST_REPO, ".grove", "worktrees", taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("pruneStaleWorktrees", () => {
  test("prunes worktree for completed task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "repo", "Done task", "completed"]);
    createFakeWorktree("W-001");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].taskId).toBe("W-001");
    expect(result.pruned[0].reason).toBe("completed");
  });

  test("prunes worktree for failed task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "repo", "Failed task", "failed"]);
    createFakeWorktree("W-002");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].reason).toBe("failed");
  });

  test("prunes worktree for orphaned task (no DB record)", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    createFakeWorktree("W-999");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].reason).toBe("orphaned");
  });

  test("skips worktree for active task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-003", "repo", "Active task", "active"]);
    createFakeWorktree("W-003");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
  });

  test("skips worktree for paused task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-004", "repo", "Paused task", "paused"]);
    createFakeWorktree("W-004");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
  });

  test("returns empty when no stale worktrees", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});
