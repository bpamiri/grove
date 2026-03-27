// Grove v3 — Health monitor
// Runs on a 15-second interval inside the broker process.
// Checks: PID liveness, stall detection, worker crash, orchestrator health.
import { bus } from "../broker/event-bus";
import { isAlive } from "../agents/stream-parser";
import { lastActivity } from "../agents/stream-parser";
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
        db.taskSetStatus(session.task_id, "failed");
        db.addEvent(session.task_id, session.id, "worker_crashed", `Worker PID ${session.pid} died unexpectedly`);
        bus.emit("monitor:crash", { taskId: session.task_id, sessionId: session.id });
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
