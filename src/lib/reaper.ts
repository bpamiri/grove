// Grove v2 — Worker health reaper: detect and clean up dead/stalled workers
import { statSync } from "node:fs";
import type { Database } from "../core/db";
import type { Session } from "../types";
import { isAlive } from "./monitor";
import { parseCosts, readSessionSummary, getFilesModified } from "./dispatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReapResult {
  taskId: string;
  pid: number;
  reason: "dead" | "stalled";
}

// ---------------------------------------------------------------------------
// Internal: shared cleanup for reaped sessions
// ---------------------------------------------------------------------------

function cleanupReapedSession(
  db: Database,
  session: Session,
  reason: "dead" | "stalled",
  detail: string,
): void {
  const taskId = session.task_id!;

  // Parse cost from log if available
  if (session.output_log) {
    const { costUsd, tokensUsed } = parseCosts(session.output_log);
    if (costUsd > 0) {
      db.exec("UPDATE tasks SET cost_usd = ? WHERE id = ?", [costUsd, taskId]);
      db.exec("UPDATE sessions SET cost_usd = ? WHERE id = ?", [costUsd, session.id]);
    }
    if (tokensUsed > 0) {
      db.exec("UPDATE tasks SET tokens_used = ? WHERE id = ?", [tokensUsed, taskId]);
      db.exec("UPDATE sessions SET tokens_used = ? WHERE id = ?", [tokensUsed, session.id]);
    }
  }

  // Capture session summary + files modified if worktree exists
  const task = db.taskGet(taskId);
  if (task?.worktree_path) {
    const summary = readSessionSummary(task.worktree_path);
    if (summary) {
      db.taskSet(taskId, "session_summary", summary);
      db.exec("UPDATE sessions SET summary = ? WHERE id = ?", [summary, session.id]);
    }

    const files = getFilesModified(task.worktree_path);
    if (files) {
      db.taskSet(taskId, "files_modified", files);
    }
  }

  // End session and mark task failed
  db.sessionEnd(session.id, "failed");
  db.taskSetStatus(taskId, "failed");
  db.addEvent(taskId, "worker_reaped", detail);
}

// ---------------------------------------------------------------------------
// reapDeadWorkers — find workers whose PID no longer exists
// ---------------------------------------------------------------------------

export function reapDeadWorkers(db: Database): ReapResult[] {
  const sessions = db.all<Session>(
    "SELECT * FROM sessions WHERE status = 'running'",
  );

  const results: ReapResult[] = [];

  for (const session of sessions) {
    if (!session.task_id) continue;
    const pid = session.pid ?? 0;

    if (!isAlive(pid)) {
      const taskId = session.task_id;
      const detail = `Worker dead: PID ${pid} not found (process died)`;

      cleanupReapedSession(db, session, "dead", detail);

      results.push({ taskId, pid, reason: "dead" });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// reapStalledWorkers — find workers alive but producing no output
// ---------------------------------------------------------------------------

export async function reapStalledWorkers(db: Database, timeoutMinutes: number): Promise<ReapResult[]> {
  const sessions = db.all<Session>(
    "SELECT * FROM sessions WHERE status = 'running'",
  );

  const results: ReapResult[] = [];
  const timeoutMs = timeoutMinutes * 60_000;

  for (const session of sessions) {
    if (!session.task_id) continue;
    if (!session.pid || session.pid <= 0) continue;
    const pid = session.pid;

    // Only check workers that are still alive
    if (!isAlive(pid)) continue;

    // Determine last activity time from log file mtime
    let mtime: number;
    if (session.output_log) {
      try {
        mtime = statSync(session.output_log).mtimeMs;
      } catch {
        // No log file — use session started_at as fallback
        mtime = new Date(session.started_at).getTime();
      }
    } else {
      // No log path — use session started_at as fallback
      mtime = new Date(session.started_at).getTime();
    }

    const elapsed = Date.now() - mtime;
    if (elapsed <= timeoutMs) continue;

    // Worker is stalled — kill it
    const taskId = session.task_id;
    const elapsedMinutes = Math.round(elapsed / 60_000);

    // SIGTERM first
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }

    // Wait up to 3s for graceful exit
    let killed = false;
    for (let i = 0; i < 15; i++) {
      if (!isAlive(pid)) {
        killed = true;
        break;
      }
      await Bun.sleep(200);
    }

    // SIGKILL if still alive
    if (!killed && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }

    const detail = `Worker stalled: No output for ${elapsedMinutes}m (stall timeout ${timeoutMinutes}m)`;
    cleanupReapedSession(db, session, "stalled", detail);

    results.push({ taskId, pid, reason: "stalled" });
  }

  return results;
}
