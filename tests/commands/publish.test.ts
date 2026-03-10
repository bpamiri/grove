import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-publish-test-"));
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  db.repoUpsert({
    name: "testrepo",
    org: "test",
    github_full: "test/testrepo",
    local_path: tempDir,
    branch_prefix: "grove/",
    claude_md_path: null,
    last_synced: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("publishTask validation", () => {
  test("returns false when task has no branch", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });

  test("returns false when task has no repo", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, branch) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "grove/T-001-fix-bug"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });

  test("returns false when worktree_path does not exist on disk", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, branch, worktree_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo", "grove/T-001-fix-bug", "/nonexistent/path"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });

  test("returns false when task not found", async () => {
    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("NOPE", db);
    expect(result).toBe(false);
  });
});

describe("generatePrBody", () => {
  test("returns fallback when no diff available", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/nonexistent", "T-001", "Did some work");
    expect(body).toContain("Did some work");
  });

  test("includes Grove footer", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/nonexistent", "T-001", "Summary text");
    expect(body).toContain("Grove");
    expect(body).toContain("T-001");
  });

  test("uses default message when no summary provided", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/does/not/exist", "T-001", null);
    expect(body).toContain("No description available");
  });
});

describe("generatePrBody edge cases", () => {
  test("falls back when git repo has empty diff", async () => {
    const repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", repoDir]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.com"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "commit.gpgsign", "false"]);
    Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"]);

    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody(repoDir, "T-001", "Fallback summary");
    expect(body).toContain("Fallback summary");
    expect(body).toContain("Grove");
  });

  test("footer always contains task ID", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/nope", "W-042", "Some summary");
    expect(body).toContain("W-042");
  });
});

describe("publishTask DB behavior", () => {
  test("pr_url and pr_number are null before publish", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, branch) VALUES (?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo", "grove/T-001-fix-bug"],
    );

    const task = db.taskGet("T-001");
    expect(task?.pr_url).toBeNull();
    expect(task?.pr_number).toBeNull();
  });

  test("returns false when repo not in config", async () => {
    // Repo exists in DB but not in grove.yaml config (configRepoDetail won't find it)
    db.repoUpsert({
      name: "noconfigrepo",
      org: "test",
      github_full: "test/noconfigrepo",
      local_path: tempDir,
      branch_prefix: "grove/",
      claude_md_path: null,
      last_synced: null,
    });
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, branch, worktree_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "noconfigrepo", "grove/T-001-fix-bug", tempDir],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    // Will fail because configRepoDetail() reads grove.yaml which doesn't have this repo
    expect(result).toBe(false);
  });
});
