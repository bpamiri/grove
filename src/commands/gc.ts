// grove gc — Garbage-collect stale events, sessions, logs, and worktrees
import { getDb, getEnv } from "../core/db";
import * as ui from "../core/ui";
import { cleanupWorktree } from "../lib/worktree";
import { unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../types";
import type { Database } from "../core/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["done", "completed", "failed"]);
const DEFAULT_DURATION = "30d";

// ---------------------------------------------------------------------------
// Duration parser (exported for tests)
// ---------------------------------------------------------------------------

export function parseDuration(input: string): Date | null {
  const match = input.match(/^(\d+)(d|w|m)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  let days: number;
  switch (unit) {
    case "d": days = n; break;
    case "w": days = n * 7; break;
    case "m": days = n * 30; break;
    default: return null;
  }
  return new Date(Date.now() - days * 86_400_000);
}

// ---------------------------------------------------------------------------
// Candidate types
// ---------------------------------------------------------------------------

interface EventCandidate {
  taskId: string;
  taskStatus: string;
  taskUpdatedAt: string;
  count: number;
}

interface SessionCandidate {
  taskId: string;
  taskStatus: string;
  taskUpdatedAt: string;
  count: number;
}

interface LogCandidate {
  filePath: string;
  fileName: string;
  taskId: string;
  sizeBytes: number;
  orphaned: boolean;
}

interface WorktreeCandidate {
  taskId: string;
  worktreePath: string;
  taskStatus: string;
}

interface GcCandidates {
  events: EventCandidate[];
  sessions: SessionCandidate[];
  logs: LogCandidate[];
  worktrees: WorktreeCandidate[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSqliteDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Extract task ID from a log filename. Supports:
 *  - {taskId}-YYYYMMDD-HHMMSS.log
 *  - {taskId}.log
 */
function parseTaskIdFromFilename(fileName: string): string | null {
  if (!fileName.endsWith(".log")) return null;
  // Try timestamped pattern first
  const tsMatch = fileName.match(/^(.+?)-\d{8}-\d{6}\.log$/);
  if (tsMatch) return tsMatch[1];
  // Plain {taskId}.log
  return fileName.slice(0, -4) || null;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function collectEvents(db: Database, cutoff: Date): EventCandidate[] {
  const cutoffStr = toSqliteDatetime(cutoff);
  const rows = db.all<{ task_id: string; status: string; updated_at: string; cnt: number }>(
    `SELECT t.id AS task_id, t.status, t.updated_at, COUNT(e.id) AS cnt
     FROM tasks t
     JOIN events e ON e.task_id = t.id
     WHERE t.status IN ('done', 'completed', 'failed')
       AND t.updated_at < ?
     GROUP BY t.id`,
    [cutoffStr],
  );
  return rows.map((r) => ({
    taskId: r.task_id,
    taskStatus: r.status,
    taskUpdatedAt: r.updated_at,
    count: r.cnt,
  }));
}

function collectSessions(db: Database, cutoff: Date): SessionCandidate[] {
  const cutoffStr = toSqliteDatetime(cutoff);
  const rows = db.all<{ task_id: string; status: string; updated_at: string; cnt: number }>(
    `SELECT t.id AS task_id, t.status, t.updated_at, COUNT(s.id) AS cnt
     FROM tasks t
     JOIN sessions s ON s.task_id = t.id
     WHERE t.status IN ('done', 'completed', 'failed')
       AND t.updated_at < ?
     GROUP BY t.id`,
    [cutoffStr],
  );
  return rows.map((r) => ({
    taskId: r.task_id,
    taskStatus: r.status,
    taskUpdatedAt: r.updated_at,
    count: r.cnt,
  }));
}

function collectLogs(db: Database, cutoff: Date, logDir: string): LogCandidate[] {
  if (!existsSync(logDir)) return [];

  const candidates: LogCandidate[] = [];
  const files = readdirSync(logDir);

  for (const fileName of files) {
    if (!fileName.endsWith(".log")) continue;

    const filePath = join(logDir, fileName);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }
    if (!stat.isFile()) continue;

    // Check file mtime against cutoff
    if (stat.mtimeMs >= cutoff.getTime()) continue;

    const taskId = parseTaskIdFromFilename(fileName);
    if (!taskId) continue;

    // Check task in DB
    const task = db.taskGet(taskId);
    if (task) {
      // Active task -> skip
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      // Terminal task, old file -> eligible
      candidates.push({ filePath, fileName, taskId, sizeBytes: stat.size, orphaned: false });
    } else {
      // Orphaned -> eligible
      candidates.push({ filePath, fileName, taskId, sizeBytes: stat.size, orphaned: true });
    }
  }

  return candidates;
}

function collectWorktrees(db: Database, cutoff: Date): WorktreeCandidate[] {
  const cutoffStr = toSqliteDatetime(cutoff);
  const rows = db.all<{ id: string; status: string; worktree_path: string }>(
    `SELECT id, status, worktree_path FROM tasks
     WHERE status IN ('done', 'completed', 'failed')
       AND updated_at < ?
       AND worktree_path IS NOT NULL
       AND worktree_path != ''`,
    [cutoffStr],
  );
  return rows
    .filter((r) => existsSync(r.worktree_path))
    .map((r) => ({
      taskId: r.id,
      worktreePath: r.worktree_path,
      taskStatus: r.status,
    }));
}

// ---------------------------------------------------------------------------
// Render / Execute
// ---------------------------------------------------------------------------

function renderDryRun(candidates: GcCandidates, durationLabel: string): void {
  ui.header(`Dry Run — gc --older-than ${durationLabel}`);

  if (candidates.events.length > 0) {
    console.log(ui.bold("Events:"));
    for (const c of candidates.events) {
      console.log(`  ${c.taskId}  ${ui.dim(`[${c.taskStatus}]`)}  ${c.count} event(s)`);
    }
    console.log();
  }

  if (candidates.sessions.length > 0) {
    console.log(ui.bold("Sessions:"));
    for (const c of candidates.sessions) {
      console.log(`  ${c.taskId}  ${ui.dim(`[${c.taskStatus}]`)}  ${c.count} session(s)`);
    }
    console.log();
  }

  if (candidates.logs.length > 0) {
    console.log(ui.bold("Logs:"));
    for (const c of candidates.logs) {
      const label = c.orphaned ? "orphaned" : c.taskId;
      console.log(`  ${c.fileName}  ${ui.dim(`[${label}]`)}  ${c.sizeBytes} bytes`);
    }
    console.log();
  }

  if (candidates.worktrees.length > 0) {
    console.log(ui.bold("Worktrees:"));
    for (const c of candidates.worktrees) {
      console.log(`  ${c.taskId}  ${ui.dim(`[${c.taskStatus}]`)}  ${c.worktreePath}`);
    }
    console.log();
  }

  const total =
    candidates.events.length +
    candidates.sessions.length +
    candidates.logs.length +
    candidates.worktrees.length;

  if (total === 0) {
    console.log("Nothing to clean.");
  } else {
    console.log(`Total: ${total} candidate(s). Run with --force to clean.`);
  }
}

function executeGc(db: Database, candidates: GcCandidates, durationLabel: string): void {
  let deleted = 0;

  for (const c of candidates.events) {
    db.exec("DELETE FROM events WHERE task_id = ?", [c.taskId]);
    deleted++;
  }

  for (const c of candidates.sessions) {
    db.exec("DELETE FROM sessions WHERE task_id = ?", [c.taskId]);
    db.exec("UPDATE tasks SET session_id = NULL, session_summary = NULL WHERE id = ?", [c.taskId]);
    deleted++;
  }

  for (const c of candidates.logs) {
    try {
      unlinkSync(c.filePath);
      deleted++;
    } catch {
      ui.warn(`Failed to delete ${c.filePath}`);
    }
  }

  for (const c of candidates.worktrees) {
    cleanupWorktree(c.taskId, db);
    // cleanupWorktree clears worktree_path on success
    const wtPath = db.taskGetField(c.taskId, "worktree_path") as string;
    if (!wtPath) deleted++;
  }

  ui.success(`GC complete (--older-than ${durationLabel}): ${deleted} item(s) cleaned.`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function help(): string {
  return [
    "Usage: grove gc [OPTIONS]",
    "",
    "Garbage-collect stale data from completed/failed tasks.",
    "",
    "Categories (at least one required):",
    "  --events       Remove events for terminal tasks",
    "  --sessions     Remove sessions for terminal tasks",
    "  --logs         Remove log files for terminal/orphaned tasks",
    "  --worktrees    Remove worktrees for terminal tasks",
    "  --all          All of the above",
    "",
    "Options:",
    "  --older-than DURATION   Age threshold (default: 30d)",
    "                          Formats: Nd (days), Nw (weeks), Nm (months)",
    "  --force                 Execute cleanup (default is dry-run)",
    "  --dry-run               Preview what would be cleaned (default)",
    "  -h, --help              Show this help",
    "",
    "Examples:",
    "  grove gc --all                        # dry-run all categories",
    "  grove gc --events --force             # delete stale events",
    "  grove gc --logs --older-than 7d       # preview logs older than 7 days",
    "  grove gc --all --older-than 2w --force",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const gcCommand: Command = {
  name: "gc",
  description: "Garbage-collect stale events, sessions, logs, and worktrees",

  async run(args: string[]) {
    // Help check
    if (args.includes("-h") || args.includes("--help")) {
      console.log(help());
      return;
    }

    // Parse flags
    let wantEvents = false;
    let wantSessions = false;
    let wantLogs = false;
    let wantWorktrees = false;
    let force = false;
    let durationInput: string | null = null;

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--events") { wantEvents = true; i++; }
      else if (arg === "--sessions") { wantSessions = true; i++; }
      else if (arg === "--logs") { wantLogs = true; i++; }
      else if (arg === "--worktrees") { wantWorktrees = true; i++; }
      else if (arg === "--all") { wantEvents = wantSessions = wantLogs = wantWorktrees = true; i++; }
      else if (arg === "--force") { force = true; i++; }
      else if (arg === "--dry-run") { i++; }
      else if (arg === "--older-than" && i + 1 < args.length) { durationInput = args[i + 1]; i += 2; }
      else if (arg.startsWith("--older-than=")) { durationInput = arg.slice("--older-than=".length); i++; }
      else { return ui.die(`Unknown flag: ${arg}`); }
    }

    // No category selected -> show help
    if (!wantEvents && !wantSessions && !wantLogs && !wantWorktrees) {
      console.log(help());
      return;
    }

    // Validate duration
    const durationLabel = durationInput || DEFAULT_DURATION;
    const cutoff = parseDuration(durationLabel);
    if (!cutoff) {
      return ui.die(`Invalid duration: '${durationLabel}'. Use Nd, Nw, or Nm (e.g. 30d, 2w, 3m).`);
    }

    const db = getDb();
    const { GROVE_LOG_DIR } = getEnv();

    // Collect candidates
    const candidates: GcCandidates = {
      events: wantEvents ? collectEvents(db, cutoff) : [],
      sessions: wantSessions ? collectSessions(db, cutoff) : [],
      logs: wantLogs ? collectLogs(db, cutoff, GROVE_LOG_DIR) : [],
      worktrees: wantWorktrees ? collectWorktrees(db, cutoff) : [],
    };

    if (force) {
      executeGc(db, candidates, durationLabel);
    } else {
      renderDryRun(candidates, durationLabel);
    }
  },

  help,
};
