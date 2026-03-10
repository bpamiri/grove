// Tests for worktree management
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";
import { slugify } from "../../src/lib/prompt-builder";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let repoDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-wt-test-"));
  repoDir = join(tempDir, "test-repo");

  // Create a real git repo for worktree tests
  Bun.spawnSync(["git", "init", repoDir]);
  Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.com"]);
  Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"]);
  Bun.spawnSync(["git", "-C", repoDir, "config", "commit.gpgsign", "false"]);
  // Need at least one commit for worktrees to work
  Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "Initial commit"]);

  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  // Register the repo
  db.repoUpsert({
    name: "testrepo",
    org: "test",
    github_full: "test/testrepo",
    local_path: repoDir,
    branch_prefix: "grove/",
    claude_md_path: null,
    last_synced: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("slugify", () => {
  test("lowercases text", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("replaces special chars with hyphens", () => {
    expect(slugify("fix: the router!")).toBe("fix-the-router");
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("one---two---three")).toBe("one-two-three");
  });

  test("max 50 chars", () => {
    const long = "a".repeat(60);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });

  test("max 50 chars does not end with hyphen", () => {
    // A string that would have a hyphen at position 50 after slug conversion
    const input = "a".repeat(49) + " b";
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("-")).toBe(false);
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("handles pure special chars", () => {
    expect(slugify("!!!@@@###")).toBe("");
  });
});

describe("createWorktree", () => {
  test("creates a worktree directory", () => {
    // Create a task
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix the router", "ready", "testrepo"],
    );

    const { createWorktree } = require("../../src/lib/worktree");
    const wtPath = createWorktree("T-001", "testrepo", db);

    expect(existsSync(wtPath)).toBe(true);
    // Worktree should be under repo/.grove/worktrees/T-001
    expect(wtPath).toContain("T-001");
  });

  test("sets branch and worktree_path in DB", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix the router", "ready", "testrepo"],
    );

    const { createWorktree } = require("../../src/lib/worktree");
    createWorktree("T-001", "testrepo", db);

    const branch = db.taskGetField("T-001", "branch");
    const wtPath = db.taskGetField("T-001", "worktree_path");

    expect(branch).toContain("grove/");
    expect(branch).toContain("T-001");
    expect(branch).toContain("fix-the-router");
    expect(wtPath).toBeTruthy();
  });

  test("creates .grove dir inside worktree", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { createWorktree } = require("../../src/lib/worktree");
    const wtPath = createWorktree("T-001", "testrepo", db);

    expect(existsSync(join(wtPath, ".grove"))).toBe(true);
  });

  test("re-creates returns same path if already exists", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { createWorktree } = require("../../src/lib/worktree");
    const path1 = createWorktree("T-001", "testrepo", db);
    const path2 = createWorktree("T-001", "testrepo", db);

    expect(path1).toBe(path2);
  });
});

describe("worktreeExists / worktreePath", () => {
  test("worktreeExists returns false when no worktree", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { worktreeExists } = require("../../src/lib/worktree");
    expect(worktreeExists("T-001", db)).toBe(false);
  });

  test("worktreeExists returns true after creation", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { createWorktree, worktreeExists } = require("../../src/lib/worktree");
    createWorktree("T-001", "testrepo", db);
    expect(worktreeExists("T-001", db)).toBe(true);
  });

  test("worktreePath returns null when no worktree", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { worktreePath } = require("../../src/lib/worktree");
    expect(worktreePath("T-001", db)).toBeNull();
  });

  test("worktreePath returns path after creation", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "ready", "testrepo"],
    );

    const { createWorktree, worktreePath } = require("../../src/lib/worktree");
    const created = createWorktree("T-001", "testrepo", db);
    const retrieved = worktreePath("T-001", db);
    expect(retrieved).toBe(created);
  });
});

describe("cleanupWorktree", () => {
  test("removes worktree and clears DB field", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "done", "testrepo"],
    );

    const { createWorktree, cleanupWorktree, worktreeExists } = require("../../src/lib/worktree");
    const wtPath = createWorktree("T-001", "testrepo", db);
    expect(existsSync(wtPath)).toBe(true);

    cleanupWorktree("T-001", db);

    expect(worktreeExists("T-001", db)).toBe(false);
    // The DB field should be empty
    const dbPath = db.taskGetField("T-001", "worktree_path");
    expect(dbPath === null || dbPath === "").toBe(true);
  });

  test("no-op when no worktree exists", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "done", "testrepo"],
    );

    const { cleanupWorktree } = require("../../src/lib/worktree");
    // Should not throw
    cleanupWorktree("T-001", db);
  });
});

describe("listWorktrees", () => {
  test("returns empty array when no worktrees", () => {
    const { listWorktrees } = require("../../src/lib/worktree");
    const entries = listWorktrees("testrepo", db);
    expect(entries).toEqual([]);
  });

  test("lists created worktrees", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "First task", "ready", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-002", "manual", "Second task", "ready", "testrepo"],
    );

    const { createWorktree, listWorktrees } = require("../../src/lib/worktree");
    createWorktree("T-001", "testrepo", db);
    createWorktree("T-002", "testrepo", db);

    const entries = listWorktrees("testrepo", db);
    expect(entries.length).toBe(2);

    const taskIds = entries.map((e: any) => e.taskId).sort();
    expect(taskIds).toEqual(["T-001", "T-002"]);
  });
});
