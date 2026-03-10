// grove cancel — Stop and clean up a task, removing worktree and discarding changes
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb, getEnv } from "../core/db";
import type { Database } from "../core/db";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { cleanupWorktree } from "../lib/worktree";
import { isAlive } from "../lib/monitor";
import type { Command, Task } from "../types";

export const cancelCommand: Command = {
  name: "cancel",
  description: "Stop and clean up a task, removing worktree and discarding changes",

  async run(args: string[]) {
    const db = getDb();

    // Parse arguments
    let taskId = "";
    let force = false;

    for (const arg of args) {
      if (arg === "--force" || arg === "-f") {
        force = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(cancelCommand.help?.() ?? "");
        return;
      } else if (!taskId) {
        taskId = arg;
      } else {
        ui.warn(`Unexpected argument: ${arg}`);
      }
    }

    if (!taskId) {
      ui.die("Usage: grove cancel TASK_ID");
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    const task = db.taskGet(taskId)!;
    const title = task.title;
    const status = task.status;
    const worktreePath = task.worktree_path;
    const branch = task.branch;
    const repo = task.repo;

    // Don't cancel already completed/failed tasks
    if (status === "completed" || status === "failed") {
      ui.die(`Task ${taskId} is already '${status}'.`);
    }

    // Confirm with user unless --force
    if (!force) {
      console.log(`${ui.bold(`Cancel ${taskId}?`)} ${title}`);
      if (worktreePath && existsSync(worktreePath)) {
        console.log("  This will remove the worktree and discard all changes.");
      }
      const confirmed = await prompts.confirm("Proceed?", false);
      if (!confirmed) {
        ui.info("Cancelled.");
        return;
      }
    }

    ui.info(`Cancelling ${taskId}: ${title}`);

    // If task is running, kill the worker process
    if (status === "running") {
      const session = db.sessionGetRunning(taskId);
      const sessionId = session?.id ?? null;
      const workerPid = session?.pid ?? null;

      if (workerPid && isAlive(workerPid)) {
        ui.debug(`Killing worker PID ${workerPid}`);
        try {
          process.kill(workerPid, "SIGTERM");
        } catch {
          // Process may have already exited
        }

        // Brief wait then force kill
        let waitCount = 0;
        while (isAlive(workerPid) && waitCount < 6) {
          await sleep(500);
          waitCount++;
        }
        if (isAlive(workerPid)) {
          try {
            process.kill(workerPid, "SIGKILL");
          } catch {
            // ignore
          }
        }
        ui.debug("Worker process stopped");
      }

      // End the active session
      if (sessionId) {
        db.sessionEnd(sessionId, "cancelled");
      }
    }

    // End any other active sessions for this task
    db.exec(
      "UPDATE sessions SET ended_at = datetime('now'), status = 'cancelled' WHERE task_id = ? AND status = 'running'",
      [taskId],
    );

    // Clean up worktree
    if (worktreePath && existsSync(worktreePath)) {
      ui.debug(`Removing worktree at ${worktreePath}`);
      cleanupWorktree(taskId, db);

      // Delete the branch
      if (branch && repo) {
        const repoRow = db.repoGet(repo);
        if (repoRow) {
          const repoPath = expandHome(repoRow.local_path);
          if (existsSync(repoPath)) {
            Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repoPath });
            ui.debug(`Deleted branch ${branch}`);
          }
        }
      }

      ui.success("Worktree removed");
    }

    // Set status to failed with cancel event
    db.taskSetStatus(taskId, "failed");
    db.taskSet(taskId, "worktree_path", "");
    db.addEvent(taskId, "cancelled", "Task cancelled by user");

    ui.success(`Cancelled ${taskId}`);
  },

  help() {
    return `Usage: grove cancel TASK_ID [--force]

Stop and clean up a task. If the task is running, the worker
process is killed. The worktree is removed and changes discarded.

The task status is set to "failed" with a "cancelled" event.

Options:
  --force, -f    Skip confirmation prompt

Examples:
  grove cancel W-005           Cancel with confirmation
  grove cancel W-005 --force   Cancel without asking`;
  },
};

/** Expand ~ to $HOME in a path */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
