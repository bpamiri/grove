// Grove test fixture helpers — reusable factories for db, repo, tree, and task
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

/** Creates a temporary SQLite database with the Grove schema applied. */
export function createTestDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "grove-test-db-"));
  const db = new Database(join(dir, "grove.db"));
  db.initFromString(SCHEMA_SQL);
  return db;
}

/** Creates a temporary git repo with an initial commit. Returns the repo path. */
export function createFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-test-repo-"));
  const exec = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
  exec("git init");
  exec('git config user.email "test@grove.test"');
  exec('git config user.name "Grove Test"');
  writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  exec("git add .");
  exec('git commit -m "init"');
  return dir;
}

interface FixtureTreeOpts {
  treeId?: string;
  config?: Record<string, unknown>;
}

/** Creates a test DB + fixture repo and registers the repo as a tree. */
export function createFixtureTree(opts: FixtureTreeOpts = {}): {
  db: Database;
  repoPath: string;
  treeId: string;
} {
  const db = createTestDb();
  const repoPath = createFixtureRepo();
  const treeId = opts.treeId ?? "test-tree";
  const config = opts.config ?? {
    quality_gates: {
      commits: true,
      tests: false,
      lint: false,
      diff_size: true,
    },
  };
  db.treeUpsert({
    id: treeId,
    name: treeId,
    path: repoPath,
    config: JSON.stringify(config),
  });
  return { db, repoPath, treeId };
}

interface FixtureTaskOpts {
  status?: string;
  title?: string;
  pathName?: string;
  worktreePath?: string;
  branch?: string;
}

/**
 * Inserts a task row into the DB. Returns the task ID.
 * Requires the treeId to already exist in the DB.
 */
export function createFixtureTask(
  db: Database,
  treeId: string,
  opts: FixtureTaskOpts = {},
): string {
  const id = db.nextTaskId("W");
  const status = opts.status ?? "draft";
  const title = opts.title ?? "Test task";
  const pathName = opts.pathName ?? "development";
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, path_name, worktree_path, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, treeId, title, status, pathName, opts.worktreePath ?? null, opts.branch ?? null],
  );
  return id;
}

/** Removes a temp directory. Best-effort — catches errors silently. */
export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
