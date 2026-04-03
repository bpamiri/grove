// Grove v3 — Database class wrapping bun:sqlite with typed helpers
import { Database as SQLiteDB } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tree, Task, Session, GroveEvent, Message } from "../shared/types";
import { groveHome } from "../shared/platform";

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
    // Add github_issue column (links task to originating GitHub issue)
    const hasGithubIssue = cols.some(c => c.name === "github_issue");
    if (!hasGithubIssue) {
      this.run("ALTER TABLE tasks ADD COLUMN github_issue INTEGER");
      // Backfill from existing "Issue #N" title suffix
      const tasks = this.all<{ id: string; title: string }>("SELECT id, title FROM tasks");
      for (const t of tasks) {
        const m = t.title.match(/\bIssue #(\d+)$/);
        if (m) this.run("UPDATE tasks SET github_issue = ? WHERE id = ?", [parseInt(m[1], 10), t.id]);
      }
    }

    // Add source_pr column (links task to contributed PR being reviewed)
    const hasSourcePr = cols.some(c => c.name === "source_pr");
    if (!hasSourcePr) {
      this.run("ALTER TABLE tasks ADD COLUMN source_pr INTEGER");
    }

    // Add labels column (comma-separated GitHub issue labels)
    const hasLabels = cols.some(c => c.name === "labels");
    if (!hasLabels) {
      this.run("ALTER TABLE tasks ADD COLUMN labels TEXT");
    }

    // Add checkpoint column (stores JSON checkpoint for resumed workers)
    const hasCheckpoint = cols.some(c => c.name === "checkpoint");
    if (!hasCheckpoint) {
      this.run("ALTER TABLE tasks ADD COLUMN checkpoint TEXT");
    }

    // Add skill_overrides column (JSON: per-step skill overrides for tasks)
    const hasSkillOverrides = cols.some(c => c.name === "skill_overrides");
    if (!hasSkillOverrides) {
      this.run("ALTER TABLE tasks ADD COLUMN skill_overrides TEXT");
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

  treeDelete(id: string): void {
    this.run("DELETE FROM trees WHERE id = ?", [id]);
  }

  taskDeleteByTree(treeId: string): number {
    return this.db.prepare("DELETE FROM tasks WHERE tree_id = ?").run(treeId).changes;
  }

  taskDelete(taskId: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId).changes > 0;
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
         AND status NOT IN ('completed', 'failed', 'closed')`,
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

  // ---- Task Edge helpers ----

  addEdge(fromTask: string, toTask: string, edgeType: string = "dependency"): void {
    this.run(
      "INSERT OR IGNORE INTO task_edges (from_task, to_task, edge_type) VALUES (?, ?, ?)",
      [fromTask, toTask, edgeType],
    );
  }

  removeEdge(fromTask: string, toTask: string): void {
    this.run("DELETE FROM task_edges WHERE from_task = ? AND to_task = ?", [fromTask, toTask]);
  }

  allTaskEdges(): Array<{ from_task: string; to_task: string; edge_type: string }> {
    return this.all("SELECT from_task, to_task, edge_type FROM task_edges");
  }

  taskEdgesFor(taskId: string): Array<{ from_task: string; to_task: string; edge_type: string }> {
    return this.all(
      "SELECT from_task, to_task, edge_type FROM task_edges WHERE from_task = ? OR to_task = ?",
      [taskId, taskId],
    );
  }

  /** Migrate existing depends_on strings to task_edges (run once on startup) */
  migrateDepends(): void {
    const tasks = this.all<{ id: string; depends_on: string }>(
      "SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL AND depends_on != ''",
    );
    for (const task of tasks) {
      for (const dep of task.depends_on.split(",").map(s => s.trim()).filter(Boolean)) {
        this.addEdge(dep, task.id);
      }
    }
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

  // ---- Analytics helpers ----
  // Note: these methods aggregate from tasks.cost_usd (per-task accumulated cost),
  // whereas costToday/costWeek aggregate from sessions.cost_usd (per-session cost).

  costByTree(since: string): { tree_name: string; tree_id: string; total_cost: number; task_count: number }[] {
    return this.all(
      `SELECT t.name AS tree_name, t.id AS tree_id,
              COALESCE(SUM(tk.cost_usd), 0) AS total_cost,
              COUNT(tk.id) AS task_count
       FROM tasks tk
       JOIN trees t ON tk.tree_id = t.id
       WHERE tk.created_at >= ?
       GROUP BY t.id
       ORDER BY total_cost DESC`,
      [since]
    );
  }

  costDaily(since: string): { date: string; total_cost: number; task_count: number }[] {
    return this.all(
      `SELECT date(created_at) AS date,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(id) AS task_count
       FROM tasks
       WHERE created_at >= ?
       GROUP BY date(created_at)
       ORDER BY date ASC`,
      [since]
    );
  }

  costTopTasks(since: string, limit: number): { task_id: string; title: string; tree_name: string | null; cost_usd: number }[] {
    return this.all(
      `SELECT tk.id AS task_id, tk.title, t.name AS tree_name, tk.cost_usd
       FROM tasks tk
       LEFT JOIN trees t ON tk.tree_id = t.id
       WHERE tk.created_at >= ? AND tk.cost_usd > 0
       ORDER BY tk.cost_usd DESC
       LIMIT ?`,
      [since, limit]
    );
  }

  gateAnalytics(since: string): { gate_type: string; pass_count: number; fail_count: number; total: number }[] {
    return this.all(
      `SELECT
         j.key AS gate_type,
         SUM(CASE WHEN json_extract(j.value, '$.passed') = 1 THEN 1 ELSE 0 END) AS pass_count,
         SUM(CASE WHEN json_extract(j.value, '$.passed') = 0 THEN 1 ELSE 0 END) AS fail_count,
         COUNT(*) AS total
       FROM tasks, json_each(tasks.gate_results) AS j
       WHERE tasks.gate_results IS NOT NULL
         AND tasks.created_at >= ?
       GROUP BY j.key
       ORDER BY total DESC`,
      [since]
    );
  }

  retryStats(since: string): { total_retried: number; avg_retries: number; max_retries: number } {
    const row = this.get<{ total_retried: number; avg_retries: number; max_retries: number }>(
      `SELECT
         COUNT(*) AS total_retried,
         COALESCE(AVG(retry_count), 0) AS avg_retries,
         COALESCE(MAX(retry_count), 0) AS max_retries
       FROM tasks
       WHERE retry_count > 0
         AND created_at >= ?`,
      [since]
    );
    return row ?? { total_retried: 0, avg_retries: 0, max_retries: 0 };
  }

  // ---- Checkpoint helpers ----

  checkpointSave(taskId: string, checkpoint: string): void {
    this.run("UPDATE tasks SET checkpoint = ? WHERE id = ?", [checkpoint, taskId]);
  }

  checkpointLoad(taskId: string): string | null {
    return this.scalar<string>("SELECT checkpoint FROM tasks WHERE id = ?", [taskId]);
  }

  taskTimeline(since: string): { task_id: string; title: string; tree_name: string | null; status: string; started_at: string; completed_at: string | null; cost_usd: number; current_step: string | null }[] {
    return this.all(
      `SELECT tk.id AS task_id, tk.title, t.name AS tree_name,
              tk.status, tk.started_at, tk.completed_at,
              tk.cost_usd, tk.current_step
       FROM tasks tk
       LEFT JOIN trees t ON tk.tree_id = t.id
       WHERE tk.started_at IS NOT NULL
         AND tk.started_at >= ?
       ORDER BY tk.started_at ASC`,
      [since]
    );
  }

  // ---- Observability analytics ----

  /** Activity timeline: tasks with start/end/step/cost for timeline rendering */
  taskActivityTimeline(since: string): any[] {
    const sinceDate = this.sinceToDate(since);
    return this.all(
      `SELECT t.id as task_id, t.title, t.tree_id, t.status, t.started_at, t.completed_at,
              t.cost_usd, t.current_step, t.step_index
       FROM tasks t
       WHERE t.started_at IS NOT NULL AND t.started_at >= ?
       ORDER BY t.started_at DESC`,
      [sinceDate],
    );
  }

  /** Worker utilization: count of active sessions bucketed by 5-min intervals */
  workerUtilization(since: string): any[] {
    const sinceDate = this.sinceToDate(since);
    return this.all(
      `SELECT strftime('%Y-%m-%d %H:%M', started_at, 'start of minute', printf('-%d minutes', CAST(strftime('%M', started_at) AS INTEGER) % 5)) as bucket,
              COUNT(*) as active_workers
       FROM sessions
       WHERE role = 'worker' AND started_at >= ?
       GROUP BY bucket
       ORDER BY bucket`,
      [sinceDate],
    );
  }

  /** Filtered events for event log viewer */
  filteredEvents(opts: { taskId?: string; eventType?: string; since?: string; limit?: number }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.taskId) { conditions.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.eventType) { conditions.push("event_type = ?"); params.push(opts.eventType); }
    if (opts.since) { conditions.push("created_at >= ?"); params.push(this.sinceToDate(opts.since)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;

    return this.all(
      `SELECT id, task_id, session_id, event_type, summary, detail, created_at
       FROM events ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, limit],
    );
  }

  // ---- Cross-task insight analytics ----

  /** Gates ranked by failure count, with the most common error message per gate */
  insightsFailingGates(since: string): { gate: string; fail_count: number; top_message: string; top_message_count: number }[] {
    return this.all(
      `SELECT
         json_extract(j.value, '$.gate') AS gate,
         COUNT(*) AS fail_count,
         (SELECT msg FROM (
           SELECT json_extract(j2.value, '$.message') AS msg, COUNT(*) AS cnt
           FROM tasks t2, json_each(t2.gate_results) AS j2
           WHERE t2.gate_results IS NOT NULL
             AND t2.status IN ('completed', 'failed')
             AND t2.created_at >= ?
             AND json_extract(j2.value, '$.passed') = 0
             AND json_extract(j2.value, '$.gate') = json_extract(j.value, '$.gate')
           GROUP BY msg
           ORDER BY cnt DESC
           LIMIT 1
         )) AS top_message,
         (SELECT cnt FROM (
           SELECT json_extract(j2.value, '$.message') AS msg, COUNT(*) AS cnt
           FROM tasks t2, json_each(t2.gate_results) AS j2
           WHERE t2.gate_results IS NOT NULL
             AND t2.status IN ('completed', 'failed')
             AND t2.created_at >= ?
             AND json_extract(j2.value, '$.passed') = 0
             AND json_extract(j2.value, '$.gate') = json_extract(j.value, '$.gate')
           GROUP BY msg
           ORDER BY cnt DESC
           LIMIT 1
         )) AS top_message_count
       FROM tasks, json_each(tasks.gate_results) AS j
       WHERE tasks.gate_results IS NOT NULL
         AND tasks.status IN ('completed', 'failed')
         AND tasks.created_at >= ?
         AND json_extract(j.value, '$.passed') = 0
       GROUP BY gate
       ORDER BY fail_count DESC
       LIMIT 10`,
      [since, since, since]
    );
  }

  /** Average and max retry count grouped by pipeline path */
  insightsRetriesByPath(since: string): { path_name: string; task_count: number; retried_count: number; avg_retries: number; max_retries: number }[] {
    return this.all(
      `SELECT
         path_name,
         COUNT(*) AS task_count,
         SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retried_count,
         COALESCE(AVG(CASE WHEN retry_count > 0 THEN retry_count END), 0) AS avg_retries,
         COALESCE(MAX(retry_count), 0) AS max_retries
       FROM tasks
       WHERE created_at >= ?
         AND status IN ('completed', 'failed')
       GROUP BY path_name
       ORDER BY avg_retries DESC`,
      [since]
    );
  }

  /** Success/failure breakdown per tree */
  insightsTreeFailureRates(since: string): { tree_id: string; tree_name: string | null; completed: number; failed: number; total: number; success_rate: number }[] {
    return this.all(
      `SELECT
         tk.tree_id,
         t.name AS tree_name,
         SUM(CASE WHEN tk.status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN tk.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total,
         ROUND(CAST(SUM(CASE WHEN tk.status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) AS success_rate
       FROM tasks tk
       LEFT JOIN trees t ON tk.tree_id = t.id
       WHERE tk.created_at >= ?
         AND tk.status IN ('completed', 'failed')
       GROUP BY tk.tree_id
       ORDER BY success_rate ASC`,
      [since]
    );
  }

  /** Daily success rate trend */
  insightsSuccessTrend(since: string): { date: string; completed: number; failed: number; total: number; success_rate: number }[] {
    return this.all(
      `SELECT
         date(created_at) AS date,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total,
         ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) AS success_rate
       FROM tasks
       WHERE created_at >= ?
         AND status IN ('completed', 'failed')
       GROUP BY date
       ORDER BY date ASC`,
      [since]
    );
  }

  /** Top N most common (gate, message) failure combinations */
  insightsCommonFailures(since: string, limit = 10): { gate: string; message: string; count: number }[] {
    return this.all(
      `SELECT
         json_extract(j.value, '$.gate') AS gate,
         json_extract(j.value, '$.message') AS message,
         COUNT(*) AS count
       FROM tasks, json_each(tasks.gate_results) AS j
       WHERE tasks.gate_results IS NOT NULL
         AND tasks.status IN ('completed', 'failed')
         AND tasks.created_at >= ?
         AND json_extract(j.value, '$.passed') = 0
       GROUP BY gate, message
       ORDER BY count DESC
       LIMIT ?`,
      [since, limit]
    );
  }

  /** Convert "1h", "4h", "24h", "7d" to SQLite-compatible datetime string */
  private sinceToDate(since: string): string {
    const now = new Date();
    const match = since.match(/^(\d+)(h|d)$/);
    if (!match) return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
    const [, num, unit] = match;
    const ms = unit === "h" ? Number(num) * 60 * 60 * 1000 : Number(num) * 24 * 60 * 60 * 1000;
    // Use space-separated format to match SQLite datetime('now') default
    return new Date(now.getTime() - ms).toISOString().replace("T", " ").replace("Z", "");
  }
}

// ---------------------------------------------------------------------------
// Singleton + Environment
// ---------------------------------------------------------------------------

let _db: Database | null = null;

export function getEnv() {
  const GROVE_HOME = groveHome();
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
