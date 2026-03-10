// grove detach — Detach from a running worker (worker continues in background)
import { existsSync } from "node:fs";
import { getDb, getEnv } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { lastActivity, isAlive } from "../lib/monitor";
import type { Command, Task, Session, Event } from "../types";

/** Find the log file for a task */
function findLogFile(taskId: string): string | null {
  const db = getDb();
  const { GROVE_LOG_DIR } = getEnv();

  const session = db.get<{ output_log: string | null }>(
    "SELECT output_log FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    [taskId],
  );

  if (session?.output_log && existsSync(session.output_log)) {
    return session.output_log;
  }

  // Fallback: glob GROVE_LOG_DIR
  if (existsSync(GROVE_LOG_DIR)) {
    const result = Bun.spawnSync([
      "sh",
      "-c",
      `ls -1 "${GROVE_LOG_DIR}/${taskId}"-*.log 2>/dev/null | tail -1`,
    ]);
    const found = result.stdout.toString().trim();
    if (found && existsSync(found)) return found;
  }

  const plainLog = `${GROVE_LOG_DIR}/${taskId}.log`;
  if (existsSync(plainLog)) return plainLog;

  return null;
}

/** Detach a single task and print info */
function detachOne(taskId: string, title: string): void {
  const db = getDb();
  const logFile = findLogFile(taskId);

  // Log event
  db.addEvent(taskId, "detached", "Worker detached from terminal");

  console.log(`${ui.pc.green(`Worker ${taskId} continues in background.`)}`);
  console.log(`  ${ui.dim("Task:")}  ${ui.truncate(title || taskId, 60)}`);
  if (logFile) {
    console.log(`  ${ui.dim("Log:")}   ${logFile}`);
  }
  console.log(`  ${ui.dim("Watch:")} grove watch ${taskId}`);
}

export const detachCommand: Command = {
  name: "detach",
  description: "Detach from a running worker (worker continues in background)",

  async run(args: string[]) {
    const db = getDb();
    let detachAll = false;
    let taskId = "";

    // Parse arguments
    for (const arg of args) {
      if (arg === "--all" || arg === "-a") {
        detachAll = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        taskId = arg;
      }
    }

    // Detach all running tasks
    if (detachAll) {
      const running = db.tasksByStatus("running");
      if (running.length === 0) {
        ui.info("No running tasks to detach.");
        return;
      }

      for (const t of running) {
        detachOne(t.id, t.title);
      }
      ui.success(`Detached ${running.length} task(s).`);
      return;
    }

    // Detach specific or auto-pick single running task
    if (!taskId) {
      const running = db.tasksByStatus("running");
      if (running.length === 0) {
        ui.die("No running tasks to detach.");
      } else if (running.length === 1) {
        taskId = running[0].id;
      } else {
        ui.die("Multiple running tasks. Specify a task ID or use --all.");
      }
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    // Verify task is running
    const task = db.taskGet(taskId)!;
    if (task.status !== "running") {
      ui.die(`Task ${taskId} is not running (status: ${task.status}).`);
    }

    detachOne(taskId, task.title);
  },

  help() {
    return `Usage: grove detach [TASK_ID] [--all]

Detach from a running worker. The worker continues
running in the background, logging to its output file.

Options:
  --all, -a    Detach all running tasks

If no TASK_ID is given and only one task is running,
that task is detached. If multiple tasks are running,
you must specify a task ID or use --all.

Examples:
  grove detach           Detach the current worker
  grove detach W-001     Detach task W-001
  grove detach --all     Detach all running workers

Resume watching with: grove watch TASK_ID`;
  },
};
