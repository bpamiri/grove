// Grove v2 — Database class wrapping bun:sqlite with typed helpers
import { Database as SQLiteDB } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, Session, Event, Repo, ConfigRow } from "../types";

export class Database {
  private db: SQLiteDB;

  constructor(dbPath: string) {
    this.db = new SQLiteDB(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
  }

  /** Initialize schema from schema.sql */
  init(schemaPath: string): void {
    const sql = readFileSync(schemaPath, "utf-8");
    this.db.exec(sql);

    // Migrations: add columns if missing (idempotent)
    const cols = this.all<{ name: string }>("PRAGMA table_info(tasks)").map(c => c.name);
    if (!cols.includes("retry_count")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0");
    }
    if (!cols.includes("max_retries")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT NULL");
    }
    if (!cols.includes("gate_results")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN gate_results TEXT");
    }
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Generic query helpers
  // -------------------------------------------------------------------------

  /** Execute SQL with no return value */
  exec(sql: string, params: any[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  /** Get a single row */
  get<T = any>(sql: string, params: any[] = []): T | null {
    return this.db.prepare(sql).get(...params) as T | null;
  }

  /** Get all rows */
  all<T = any>(sql: string, params: any[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Get a single scalar value */
  scalar<T = any>(sql: string, params: any[] = []): T | null {
    const row = this.db.prepare(sql).get(...params) as Record<string, T> | null;
    if (!row) return null;
    return Object.values(row)[0] as T;
  }

  // -------------------------------------------------------------------------
  // Config table helpers (key-value store)
  // -------------------------------------------------------------------------

  configGet(key: string): string | null {
    const row = this.get<ConfigRow>(
      "SELECT value FROM config WHERE key = ?",
      [key]
    );
    return row?.value ?? null;
  }

  configSet(key: string, value: string): void {
    this.exec(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      [key, value, value]
    );
  }

  // -------------------------------------------------------------------------
  // Task helpers
  // -------------------------------------------------------------------------

  taskGet(taskId: string): Task | null {
    return this.get<Task>("SELECT * FROM tasks WHERE id = ?", [taskId]);
  }

  taskGetField(taskId: string, field: string): any {
    // field name is validated by the caller — not user input
    const row = this.get<any>(
      `SELECT "${field}" FROM tasks WHERE id = ?`,
      [taskId]
    );
    return row ? row[field] : null;
  }

  taskSet(taskId: string, field: string, value: any): void {
    this.exec(
      `UPDATE tasks SET "${field}" = ?, updated_at = datetime('now') WHERE id = ?`,
      [value, taskId]
    );
  }

  taskSetStatus(taskId: string, status: string): void {
    this.exec(
      "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?",
      [status, taskId]
    );
    this.exec(
      "INSERT INTO events (task_id, event_type, summary) VALUES (?, 'status_change', ?)",
      [taskId, `Status changed to ${status}`]
    );
  }

  taskCount(status?: string): number {
    if (status) {
      return this.scalar<number>(
        "SELECT COUNT(*) FROM tasks WHERE status = ?",
        [status]
      ) ?? 0;
    }
    return this.scalar<number>("SELECT COUNT(*) FROM tasks") ?? 0;
  }

  tasksByStatus(status: string): Task[] {
    return this.all<Task>(
      "SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC",
      [status]
    );
  }

  /** Generate next task ID for a prefix (e.g., "W" → "W-006") */
  nextTaskId(prefix: string): string {
    const maxNum = this.scalar<number>(
      "SELECT COALESCE(MAX(CAST(SUBSTR(id, LENGTH(?) + 2) AS INTEGER)), 0) FROM tasks WHERE id LIKE ? AND id GLOB ?",
      [prefix, `${prefix}-%`, `${prefix}-[0-9]*`]
    ) ?? 0;
    return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
  }

  taskExists(taskId: string): boolean {
    return (this.scalar<number>(
      "SELECT COUNT(*) FROM tasks WHERE id = ?",
      [taskId]
    ) ?? 0) > 0;
  }

  /** Check if a task is blocked by incomplete dependencies */
  isTaskBlocked(taskId: string): boolean {
    const task = this.taskGet(taskId);
    if (!task?.depends_on) return false;
    const deps = task.depends_on.split(",").map((d) => d.trim()).filter(Boolean);
    return deps.some((dep) => {
      const depTask = this.taskGet(dep);
      return !depTask || (depTask.status !== "done" && depTask.status !== "completed");
    });
  }

  /** Find tasks that just became unblocked because completedTaskId finished */
  getNewlyUnblocked(completedTaskId: string): Task[] {
    const candidates = this.all<Task>(
      `SELECT * FROM tasks
       WHERE (',' || depends_on || ',') LIKE ?
         AND status NOT IN ('done', 'completed', 'failed')`,
      [`%,${completedTaskId},%`]
    );
    return candidates.filter((t) => !this.isTaskBlocked(t.id));
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  addEvent(
    taskId: string | null,
    eventType: string,
    summary: string,
    detail?: string
  ): void {
    if (detail) {
      this.exec(
        "INSERT INTO events (task_id, event_type, summary, detail) VALUES (?, ?, ?, ?)",
        [taskId, eventType, summary, detail]
      );
    } else {
      this.exec(
        "INSERT INTO events (task_id, event_type, summary) VALUES (?, ?, ?)",
        [taskId, eventType, summary]
      );
    }
  }

  recentEvents(limit: number = 20): Event[] {
    return this.all<Event>(
      "SELECT * FROM events ORDER BY timestamp DESC LIMIT ?",
      [limit]
    );
  }

  // -------------------------------------------------------------------------
  // Session helpers
  // -------------------------------------------------------------------------

  sessionCreate(taskId: string): number {
    const repo = this.taskGetField(taskId, "repo");
    this.exec(
      "INSERT INTO sessions (task_id, repo, status) VALUES (?, ?, 'running')",
      [taskId, repo]
    );
    return this.scalar<number>("SELECT last_insert_rowid()") ?? 0;
  }

  sessionEnd(sessionId: number, status: string = "completed"): void {
    this.exec(
      "UPDATE sessions SET ended_at = datetime('now'), status = ? WHERE id = ?",
      [status, sessionId]
    );
  }

  sessionGetRunning(taskId: string): Session | null {
    return this.get<Session>(
      "SELECT * FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
      [taskId]
    );
  }

  // -------------------------------------------------------------------------
  // Cost / budget helpers
  // -------------------------------------------------------------------------

  costToday(): number {
    return this.scalar<number>(
      "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE date(started_at) = date('now')"
    ) ?? 0;
  }

  costWeek(): number {
    return this.scalar<number>(
      "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE started_at >= date('now', 'weekday 1', '-7 days')"
    ) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Repo helpers
  // -------------------------------------------------------------------------

  repoGet(name: string): Repo | null {
    return this.get<Repo>("SELECT * FROM repos WHERE name = ?", [name]);
  }

  repoUpsert(repo: Repo): void {
    this.exec(
      `INSERT INTO repos (name, org, github_full, local_path, branch_prefix)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         org = ?, github_full = ?, local_path = ?, branch_prefix = ?`,
      [
        repo.name, repo.org, repo.github_full, repo.local_path,
        repo.branch_prefix ?? "grove/",
        repo.org, repo.github_full, repo.local_path,
        repo.branch_prefix ?? "grove/",
      ]
    );
  }

  allRepos(): Repo[] {
    return this.all<Repo>("SELECT * FROM repos ORDER BY name");
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    const { GROVE_DB } = getEnv();
    _db = new Database(GROVE_DB);
  }
  return _db;
}

export function initDb(): Database {
  const { GROVE_DB, GROVE_ROOT } = getEnv();
  const db = new Database(GROVE_DB);
  db.init(join(GROVE_ROOT, "schema.sql"));
  _db = db;
  return db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function getEnv() {
  const GROVE_HOME = process.env.GROVE_HOME || join(process.env.HOME || "~", ".grove");
  const GROVE_ROOT = process.env.GROVE_ROOT || join(import.meta.dir, "../..");
  const GROVE_DB = join(GROVE_HOME, "grove.db");
  const GROVE_CONFIG = join(GROVE_HOME, "grove.yaml");
  const GROVE_LOG_DIR = join(GROVE_HOME, "logs");

  return { GROVE_HOME, GROVE_ROOT, GROVE_DB, GROVE_CONFIG, GROVE_LOG_DIR };
}
