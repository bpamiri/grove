// Grove v3 — Database class wrapping bun:sqlite with typed helpers
import { Database as SQLiteDB } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tree, Task, Session, GroveEvent, Message } from "../shared/types";

export class Database {
  private db: SQLiteDB;

  constructor(dbPath: string) {
    this.db = new SQLiteDB(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
  }

  init(schemaPath: string): void {
    const sql = readFileSync(schemaPath, "utf-8");
    this.db.exec(sql);
    this.migrate();
  }

  /** Initialize from an embedded SQL string (for compiled binary) */
  initFromString(sql: string): void {
    this.db.exec(sql);
    this.migrate();
  }

  private migrate(): void {
    const cols = this.all<{ name: string }>("PRAGMA table_info(tasks)");
    const hasCurrentStep = cols.some(c => c.name === "current_step");
    if (!hasCurrentStep) {
      this.run("ALTER TABLE tasks ADD COLUMN current_step TEXT");
      this.run("ALTER TABLE tasks ADD COLUMN step_index INTEGER DEFAULT 0");
      this.run("ALTER TABLE tasks ADD COLUMN paused INTEGER DEFAULT 0");

      this.run("UPDATE tasks SET status = 'draft', current_step = NULL WHERE status = 'planned'");
      this.run("UPDATE tasks SET status = 'queued', current_step = 'plan' WHERE status = 'ready'");
      this.run("UPDATE tasks SET status = 'active', current_step = 'implement' WHERE status = 'running'");
      this.run("UPDATE tasks SET status = 'active', current_step = 'evaluate' WHERE status = 'evaluating'");
      this.run("UPDATE tasks SET status = 'active', current_step = 'implement', paused = 1 WHERE status = 'paused'");
      this.run("UPDATE tasks SET status = 'completed', current_step = '$done' WHERE status IN ('merged', 'completed', 'done')");
      this.run("UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE status IN ('failed', 'ci_failed')");
    }
    // Always fix any stale 'planned' status (SQLite ALTER TABLE doesn't change column defaults)
    this.run("UPDATE tasks SET status = 'draft' WHERE status = 'planned'");
  }

  close(): void {
    this.db.close();
  }

  // ---- Generic helpers ----

  run(sql: string, params: any[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  get<T = any>(sql: string, params: any[] = []): T | null {
    return this.db.prepare(sql).get(...params) as T | null;
  }

  all<T = any>(sql: string, params: any[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  scalar<T = any>(sql: string, params: any[] = []): T | null {
    const row = this.db.prepare(sql).get(...params) as Record<string, T> | null;
    if (!row) return null;
    return Object.values(row)[0] as T;
  }

  // ---- Tree helpers ----

  treeGet(id: string): Tree | null {
    return this.get<Tree>("SELECT * FROM trees WHERE id = ?", [id]);
  }

  treeUpsert(tree: { id: string; name: string; path: string; github?: string; branch_prefix?: string; config?: string }): void {
    this.run(
      `INSERT INTO trees (id, name, path, github, branch_prefix, config)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = ?, path = ?, github = ?, branch_prefix = ?, config = ?`,
      [
        tree.id, tree.name, tree.path, tree.github ?? null,
        tree.branch_prefix ?? "grove/", tree.config ?? "{}",
        tree.name, tree.path, tree.github ?? null,
        tree.branch_prefix ?? "grove/", tree.config ?? "{}",
      ]
    );
  }

  allTrees(): Tree[] {
    return this.all<Tree>("SELECT * FROM trees ORDER BY name");
  }

  // ---- Task helpers ----

  taskGet(taskId: string): Task | null {
    return this.get<Task>("SELECT * FROM tasks WHERE id = ?", [taskId]);
  }

  taskSetStatus(taskId: string, status: string): void {
    this.run(
      "UPDATE tasks SET status = ? WHERE id = ?",
      [status, taskId]
    );
    this.addEvent(taskId, null, "status_change", `Status changed to ${status}`);
  }

  tasksByStatus(status: string): Task[] {
    return this.all<Task>(
      "SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC",
      [status]
    );
  }

  tasksByTree(treeId: string): Task[] {
    return this.all<Task>(
      "SELECT * FROM tasks WHERE tree_id = ? ORDER BY created_at DESC",
      [treeId]
    );
  }

  taskCount(status?: string): number {
    if (status) {
      return this.scalar<number>("SELECT COUNT(*) FROM tasks WHERE status = ?", [status]) ?? 0;
    }
    return this.scalar<number>("SELECT COUNT(*) FROM tasks") ?? 0;
  }

  nextTaskId(prefix: string = "W"): string {
    const maxNum = this.scalar<number>(
      "SELECT COALESCE(MAX(CAST(SUBSTR(id, LENGTH(?) + 2) AS INTEGER)), 0) FROM tasks WHERE id LIKE ? AND id GLOB ?",
      [prefix, `${prefix}-%`, `${prefix}-[0-9]*`]
    ) ?? 0;
    return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
  }

  isTaskBlocked(taskId: string): boolean {
    const task = this.taskGet(taskId);
    if (!task?.depends_on) return false;
    const deps = task.depends_on.split(",").map(d => d.trim()).filter(Boolean);
    return deps.some(dep => {
      const depTask = this.taskGet(dep);
      return !depTask || depTask.status !== "completed";
    });
  }

  getNewlyUnblocked(completedTaskId: string): Task[] {
    const candidates = this.all<Task>(
      `SELECT * FROM tasks
       WHERE (',' || depends_on || ',') LIKE ?
         AND status NOT IN ('completed', 'failed')`,
      [`%,${completedTaskId},%`]
    );
    return candidates.filter(t => !this.isTaskBlocked(t.id));
  }

  subTasks(parentTaskId: string): Task[] {
    return this.all<Task>(
      "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
      [parentTaskId]
    );
  }

  // ---- Session helpers ----

  sessionCreate(id: string, taskId: string | null, role: string, pid?: number, tmuxPane?: string, logPath?: string): void {
    this.run(
      "INSERT INTO sessions (id, task_id, role, pid, tmux_pane, log_path) VALUES (?, ?, ?, ?, ?, ?)",
      [id, taskId, role, pid ?? null, tmuxPane ?? null, logPath ?? null]
    );
  }

  sessionEnd(sessionId: string, status: string = "completed"): void {
    this.run(
      "UPDATE sessions SET ended_at = datetime('now'), status = ? WHERE id = ?",
      [status, sessionId]
    );
  }

  sessionGetRunning(taskId: string): Session | null {
    return this.get<Session>(
      "SELECT * FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      [taskId]
    );
  }

  sessionUpdateCost(sessionId: string, costUsd: number, tokensUsed: number): void {
    this.run(
      "UPDATE sessions SET cost_usd = ?, tokens_used = ? WHERE id = ?",
      [costUsd, tokensUsed, sessionId]
    );
  }

  // ---- Event helpers ----

  addEvent(taskId: string | null, sessionId: string | null, eventType: string, summary: string, detail?: string): void {
    this.run(
      "INSERT INTO events (task_id, session_id, event_type, summary, detail) VALUES (?, ?, ?, ?, ?)",
      [taskId, sessionId, eventType, summary, detail ?? null]
    );
  }

  recentEvents(limit: number = 20): GroveEvent[] {
    return this.all<GroveEvent>(
      "SELECT * FROM events ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
  }

  eventsByTask(taskId: string): GroveEvent[] {
    return this.all<GroveEvent>(
      "SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC",
      [taskId]
    );
  }

  // ---- Message helpers ----

  addMessage(source: string, content: string, channel: string = "main"): number {
    this.run(
      "INSERT INTO messages (source, channel, content) VALUES (?, ?, ?)",
      [source, channel, content]
    );
    return this.scalar<number>("SELECT last_insert_rowid()") ?? 0;
  }

  recentMessages(channel: string = "main", limit: number = 50): Message[] {
    return this.all<Message>(
      "SELECT * FROM messages WHERE channel = ? ORDER BY created_at DESC LIMIT ?",
      [channel, limit]
    );
  }

  clearMessages(): void {
    this.run("DELETE FROM messages");
  }

  // ---- Seed operations ----

  seedCreate(taskId: string): void {
    this.run(
      "INSERT OR REPLACE INTO seeds (task_id, status) VALUES (?, 'active')",
      [taskId],
    );
  }

  seedGet(taskId: string): {
    id: number; task_id: string; summary: string | null; spec: string | null;
    conversation: string | null; status: string; created_at: string; completed_at: string | null;
  } | null {
    return this.get(
      "SELECT * FROM seeds WHERE task_id = ? AND status != 'discarded'",
      [taskId],
    );
  }

  seedComplete(taskId: string, summary: string, spec: string): void {
    this.run(
      "UPDATE seeds SET summary = ?, spec = ?, status = 'completed', completed_at = datetime('now') WHERE task_id = ? AND status = 'active'",
      [summary, spec, taskId],
    );
  }

  seedUpdateConversation(taskId: string, messages: any[]): void {
    this.run(
      "UPDATE seeds SET conversation = ? WHERE task_id = ? AND status = 'active'",
      [JSON.stringify(messages), taskId],
    );
  }

  seedDiscard(taskId: string): void {
    this.run(
      "UPDATE seeds SET status = 'discarded' WHERE task_id = ? AND status IN ('active', 'completed')",
      [taskId],
    );
  }

  seedDelete(taskId: string): void {
    this.run("DELETE FROM seeds WHERE task_id = ?", [taskId]);
  }

  // ---- Cost helpers ----

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
}

// ---------------------------------------------------------------------------
// Singleton + Environment
// ---------------------------------------------------------------------------

let _db: Database | null = null;

export function getEnv() {
  const GROVE_HOME = process.env.GROVE_HOME || join(process.env.HOME || "~", ".grove");
  const GROVE_DB = join(GROVE_HOME, "grove.db");
  const GROVE_CONFIG = join(GROVE_HOME, "grove.yaml");
  const GROVE_LOG_DIR = join(GROVE_HOME, "logs");

  return { GROVE_HOME, GROVE_DB, GROVE_CONFIG, GROVE_LOG_DIR };
}

export function getDb(): Database {
  if (!_db) {
    const { GROVE_DB } = getEnv();
    _db = new Database(GROVE_DB);
  }
  return _db;
}

export function initDb(schemaPath: string): Database {
  const { GROVE_DB } = getEnv();
  const db = new Database(GROVE_DB);
  db.init(schemaPath);
  _db = db;
  return db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
