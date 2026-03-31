// Integration test helpers — create isolated test brokers with mock claude
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import * as yaml from "yaml";

export interface TestBroker {
  db: Database;
  groveHome: string;
  treePath: string;
  configPath: string;
  logDir: string;
  cleanup: () => void;
}

/** Create an isolated test environment with DB, config, and git repo */
export function createTestBroker(opts?: {
  mockBehavior?: string;
  treeName?: string;
}): TestBroker {
  const id = `grove-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const groveHome = join(tmpdir(), id);
  const treePath = join(groveHome, "test-repo");
  const logDir = join(groveHome, "logs");
  const configPath = join(groveHome, "grove.yaml");
  const dbPath = join(groveHome, "grove.db");

  // Create directories
  mkdirSync(groveHome, { recursive: true });
  mkdirSync(treePath, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Initialize git repo
  Bun.spawnSync(["git", "init"], { cwd: treePath });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: treePath });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: treePath });
  writeFileSync(join(treePath, "README.md"), "# Test Repo");
  Bun.spawnSync(["git", "add", "-A"], { cwd: treePath });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: treePath });

  // Write config
  const config = {
    version: 2,
    workspace: { name: "Test" },
    trees: {
      [opts?.treeName ?? "test"]: {
        path: treePath,
        branch_prefix: "grove/",
      },
    },
    paths: {},
    budgets: { per_task: 5, per_session: 10, per_day: 25, per_week: 100, auto_approve_under: 2 },
    server: { port: "auto" },
    tunnel: { provider: "cloudflare", auth: "none" },
    settings: { max_workers: 2, branch_prefix: "grove/", stall_timeout_minutes: 5, max_retries: 2 },
  };
  writeFileSync(configPath, yaml.stringify(config));

  // Initialize DB
  const db = new Database(dbPath);
  db.initFromString(SCHEMA_SQL);

  // Sync tree to DB
  db.treeUpsert({
    id: opts?.treeName ?? "test",
    name: opts?.treeName ?? "test",
    path: treePath,
    github: undefined,
    branch_prefix: "grove/",
    config: "{}",
  });

  const cleanup = () => {
    db.close();
    rmSync(groveHome, { recursive: true, force: true });
  };

  return { db, groveHome, treePath, configPath, logDir, cleanup };
}

/** Create a task in the test DB and return its ID */
export function createTestTask(db: Database, opts?: {
  treeId?: string;
  title?: string;
  status?: string;
  pathName?: string;
}): string {
  const id = db.nextTaskId("W");
  db.run(
    "INSERT INTO tasks (id, tree_id, title, status, path_name) VALUES (?, ?, ?, ?, ?)",
    [id, opts?.treeId ?? "test", opts?.title ?? "Test task", opts?.status ?? "draft", opts?.pathName ?? "development"],
  );
  return id;
}

/** Path to the mock claude script */
export const MOCK_CLAUDE_PATH = join(import.meta.dir, "../fixtures/mock-claude.ts");
