// Grove v3 — Health monitor
// Runs on a 15-second interval inside the broker process.
// Checks: PID liveness, stall detection, worker crash, orchestrator health.
// Also provides startup recovery for tasks orphaned by a previous crash/restart.
import { bus } from "../broker/event-bus";
import { isAlive } from "../agents/stream-parser";
import { lastActivity } from "../agents/stream-parser";
import { getActiveWorkers } from "../agents/worker";
import { createCheckpoint } from "../agents/checkpoint";
import type { Database } from "../broker/db";

interface MonitorOptions {
  db: Database;
  stallTimeoutMinutes: number;
  intervalMs?: number;
  onOrchestratorCrash?: () => void;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startHealthMonitor(opts: MonitorOptions): void {
  const { db, stallTimeoutMinutes, intervalMs = 15_000, onOrchestratorCrash } = opts;

  if (intervalHandle) return; // Already running

  intervalHandle = setInterval(() => {
    checkWorkers(db, stallTimeoutMinutes);
    checkOrchestrator(db, onOrchestratorCrash);
  }, intervalMs);
}

export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Check all running worker sessions for crashes and stalls */
function checkWorkers(db: Database, stallTimeoutMinutes: number): void {
  const runningSessions = db.all<{
    id: string;
    task_id: string;
    pid: number | null;
    log_path: string | null;
    started_at: string;
  }>(
    "SELECT id, task_id, pid, log_path, started_at FROM sessions WHERE role = 'worker' AND status = 'running'"
  );

  for (const session of runningSessions) {
    // Check PID liveness
    if (session.pid && !isAlive(session.pid)) {
      // Worker crashed — PID dead but session still "running"
      db.sessionEnd(session.id, "crashed");
      if (session.task_id) {
        db.addEvent(session.task_id, session.id, "worker_crashed", `Worker PID ${session.pid} died unexpectedly`);
        bus.emit("monitor:crash", { taskId: session.task_id, sessionId: session.id });
        recoverTask(db, session.task_id, "worker crash");
      }
      continue;
    }

    // Check for stalls (no log activity for stallTimeoutMinutes)
    if (session.log_path) {
      const activity = lastActivity(session.log_path);
      if (activity === "idle" || activity === "no log") {
        // Check how long since last activity by looking at log file mtime
        try {
          const { statSync } = require("node:fs");
          const stat = statSync(session.log_path);
          const minutesSinceModified = (Date.now() - stat.mtimeMs) / 60_000;

          if (minutesSinceModified >= stallTimeoutMinutes) {
            if (session.task_id) {
              // Save checkpoint before marking as stalled
              try {
                const task = db.taskGet(session.task_id);
                const handle = getActiveWorkers().get(session.task_id);
                if (task && handle?.worktreePath) {
                  const checkpoint = createCheckpoint(handle.worktreePath, {
                    taskId: task.id,
                    stepId: task.current_step ?? "",
                    stepIndex: task.step_index ?? 0,
                    sessionSummary: task.session_summary ?? "Stalled — no activity detected",
                    costSoFar: task.cost_usd,
                    tokensSoFar: task.tokens_used,
                  });
                  db.checkpointSave(task.id, JSON.stringify(checkpoint));
                }
              } catch (err) {
                console.error(`[health] Checkpoint failed for stalled worker:`, err);
              }

              db.addEvent(
                session.task_id, session.id, "worker_stalled",
                `No activity for ${Math.round(minutesSinceModified)} minutes`
              );
              bus.emit("monitor:stall", {
                taskId: session.task_id,
                sessionId: session.id,
                inactiveMinutes: Math.round(minutesSinceModified),
              });
            }
          }
        } catch {
          // Can't stat file — skip
        }
      }
    }
  }
}

/** Attempt to recover a task by re-enqueuing if retry budget allows */
function recoverTask(db: Database, taskId: string, reason: string): void {
  const task = db.get<{ id: string; retry_count: number; max_retries: number; status: string }>(
    "SELECT id, retry_count, max_retries, status FROM tasks WHERE id = ?", [taskId]
  );
  if (!task) return;

  // Only recover tasks that aren't already completed/queued
  if (task.status === "completed" || task.status === "queued") return;

  if (task.retry_count < task.max_retries + 2) {
    // Re-enqueue: set to queued, increment retry, clear paused
    db.run(
      "UPDATE tasks SET status = 'queued', retry_count = retry_count + 1, paused = 0 WHERE id = ?",
      [taskId]
    );
    db.addEvent(taskId, null, "auto_recovered", `Auto-recovered after ${reason} (attempt ${task.retry_count + 2})`);

    // Enqueue for dispatch
    try {
      const { enqueue } = require("../broker/dispatch");
      enqueue(taskId);
    } catch { /* dispatch may not be initialized yet during startup */ }
  } else {
    db.run("UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?", [taskId]);
    db.addEvent(taskId, null, "recovery_exhausted", `Cannot recover: retry budget exhausted after ${reason}`);
  }
}

/**
 * Startup recovery: find tasks orphaned by a previous crash/restart and re-enqueue them.
 * Called once during broker startup, after dispatch is initialized.
 */
export function recoverOrphanedTasks(db: Database): void {
  // Find tasks that were active (running) when the broker died
  const orphaned = db.all<{ id: string; status: string; current_step: string | null }>(
    "SELECT id, status, current_step FROM tasks WHERE status = 'active' AND paused = 0"
  );

  // Also find tasks that failed due to crash (not exhausted retries) — recent failures only
  const crashed = db.all<{ id: string; retry_count: number; max_retries: number }>(
    `SELECT t.id, t.retry_count, t.max_retries FROM tasks t
     JOIN events e ON e.task_id = t.id
     WHERE t.status = 'failed'
       AND e.event_type = 'worker_crashed'
       AND e.created_at > datetime('now', '-5 minutes')
     GROUP BY t.id`
  );

  // Close any stale "running" sessions from previous process
  db.run(
    "UPDATE sessions SET status = 'crashed', ended_at = datetime('now') WHERE status = 'running'"
  );

  let recovered = 0;

  for (const task of orphaned) {
    recoverTask(db, task.id, "broker restart");
    recovered++;
  }

  for (const task of crashed) {
    recoverTask(db, task.id, "post-crash recovery");
    recovered++;
  }

  if (recovered > 0) {
    db.addEvent(null, null, "startup_recovery", `Recovered ${recovered} orphaned task(s)`);
  }
}

/** Check if the orchestrator is still alive */
function checkOrchestrator(db: Database, onCrash?: () => void): void {
  const orchestratorSession = db.get<{ id: string; pid: number | null }>(
    "SELECT id, pid FROM sessions WHERE role = 'orchestrator' AND status = 'running' ORDER BY started_at DESC LIMIT 1"
  );

  if (!orchestratorSession) return;

  if (orchestratorSession.pid && !isAlive(orchestratorSession.pid)) {
    db.sessionEnd(orchestratorSession.id, "crashed");
    db.addEvent(null, orchestratorSession.id, "orchestrator_crashed", "Orchestrator process died");
    onCrash?.();
  }
}
