import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";

/**
 * Create a temp SQLite database initialized with the Grove schema.
 * Returns the db instance and a cleanup function.
 */
export function createTestDb(): { db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `grove-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.initFromString(SCHEMA_SQL);

  const cleanup = () => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
  };

  return { db, cleanup };
}

export interface FixtureRepoOptions {
  /** Create an initial commit with a README (default: true) */
  initialCommit?: boolean;
  /** Extra files to create and commit: { "src/index.ts": "content" } */
  files?: Record<string, string>;
  /** Branch to create and switch to after initial commit */
  branch?: string;
}

/**
 * Create a real git repo in a temp directory.
 * Returns the repo path and a cleanup function.
 */
export function createFixtureRepo(opts: FixtureRepoOptions = {}): { repoPath: string; cleanup: () => void } {
  const { initialCommit = true, files, branch } = opts;
  const repoPath = join(tmpdir(), `grove-test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });

  // Init repo with "main" as default branch
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoPath, stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: repoPath, stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: repoPath, stdin: "ignore" });

  if (initialCommit) {
    writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Initial commit"], { cwd: repoPath, stdin: "ignore" });
  }

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(repoPath, filePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add fixture files"], { cwd: repoPath, stdin: "ignore" });
  }

  if (branch) {
    Bun.spawnSync(["git", "checkout", "-b", branch], { cwd: repoPath, stdin: "ignore" });
  }

  const cleanup = () => {
    rmSync(repoPath, { recursive: true, force: true });
  };

  return { repoPath, cleanup };
}
