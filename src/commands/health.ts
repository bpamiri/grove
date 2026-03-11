// grove health — Report worker health and optionally reap dead/stalled workers
import { existsSync, statSync } from "node:fs";
import { getDb } from "../core/db";
import { settingsGet } from "../core/config";
import * as ui from "../core/ui";
import { isAlive, lastActivity } from "../lib/monitor";
import { reapDeadWorkers, reapStalledWorkers } from "../lib/reaper";
import type { Command, Session } from "../types";

export const healthCommand: Command = {
  name: "health",
  description: "Report the health of all running workers",

  async run(args: string[]) {
    let reap = false;

    for (const arg of args) {
      if (arg === "--reap") {
        reap = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(healthCommand.help?.() ?? "");
        return;
      } else {
        ui.die(`Unknown argument: ${arg}`);
      }
    }

    const db = getDb();
    const stallTimeout = settingsGet("stall_timeout_minutes") || 10;

    // Query all running sessions
    const sessions = db.all<Session>(
      "SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at ASC",
    );

    if (sessions.length === 0) {
      ui.info("No running workers.");
      return;
    }

    // Report table
    ui.header("Worker Health");

    const colTask = 10;
    const colRepo = 14;
    const colPid = 10;
    const colStatus = 8;
    const colActivity = 25;
    const colIdle = 8;

    console.log(
      ui.bold(
        ui.pad("TASK", colTask) +
        ui.pad("REPO", colRepo) +
        ui.pad("PID", colPid) +
        ui.pad("STATUS", colStatus) +
        ui.pad("LAST ACTIVITY", colActivity) +
        ui.pad("IDLE", colIdle),
      ),
    );

    let deadCount = 0;

    for (const session of sessions) {
      const taskId = session.task_id ?? "?";
      const task = db.taskGet(taskId);
      const repo = task?.repo ?? "?";
      const pid = session.pid ?? 0;
      const alive = isAlive(pid);

      if (!alive) deadCount++;

      // Determine last activity
      let activity = "unknown";
      const logFile = session.output_log;
      if (logFile && existsSync(logFile)) {
        activity = lastActivity(logFile);
      }

      // Determine idle time from log file mtime
      let idleStr = "-";
      if (logFile && existsSync(logFile)) {
        try {
          const mtime = statSync(logFile).mtimeMs;
          const elapsedMs = Date.now() - mtime;
          const elapsedMin = Math.floor(elapsedMs / 60_000);
          const elapsedSec = Math.floor((elapsedMs % 60_000) / 1000);
          idleStr = `${elapsedMin}:${String(elapsedSec).padStart(2, "0")}`;
          if (elapsedMin >= stallTimeout) {
            idleStr += " \u26A0";
          }
        } catch {
          // stat failed
        }
      }

      const statusStr = alive ? "alive" : "DEAD";

      console.log(
        ui.pad(taskId, colTask) +
        ui.pad(ui.truncate(repo, colRepo - 1), colRepo) +
        ui.pad(String(pid), colPid) +
        ui.pad(statusStr, colStatus) +
        ui.pad(ui.truncate(activity, colActivity - 1), colActivity) +
        idleStr,
      );
    }

    console.log();

    // Reap if requested
    if (reap) {
      ui.info("Reaping dead and stalled workers...");
      const deadResults = reapDeadWorkers(db);
      const stalledResults = await reapStalledWorkers(db, stallTimeout);

      const total = deadResults.length + stalledResults.length;
      if (total === 0) {
        ui.info("No workers to reap.");
      } else {
        for (const r of deadResults) {
          ui.success(`Reaped ${r.taskId} (PID ${r.pid}, dead)`);
        }
        for (const r of stalledResults) {
          ui.success(`Reaped ${r.taskId} (PID ${r.pid}, stalled)`);
        }
        ui.info(`Reaped ${total} worker${total !== 1 ? "s" : ""}.`);
      }
    } else if (deadCount > 0) {
      ui.warn(
        `${deadCount} dead worker${deadCount !== 1 ? "s" : ""} detected. Run ${ui.bold("grove health --reap")} to clean up.`,
      );
    }
  },

  help() {
    return `Usage: grove health [--reap]

Report the health of all running workers.

Shows a table with each worker's task ID, repo, PID status (alive/dead),
last activity, and idle time. Workers idle beyond the stall timeout show \u26A0.

Options:
  --reap    Kill dead/stalled workers and mark their tasks as failed

Stall timeout is configured via settings.stall_timeout_minutes (default: 10).
Set it with: grove config set settings.stall_timeout_minutes 15

Reaped tasks keep their worktrees for inspection. Use "grove work TASK_ID"
to retry a reaped task, or "grove cancel TASK_ID" to clean up.

Examples:
  grove health              Show worker status report
  grove health --reap       Report + clean up dead/stalled workers`;
  },
};
