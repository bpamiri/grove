// grove pause — Signal a running worker to save state and stop
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getEnv } from "../core/db";
import type { Database } from "../core/db";
import * as ui from "../core/ui";
import { parseCost, isAlive } from "../lib/monitor";
import type { Command, Task } from "../types";

export const pauseCommand: Command = {
  name: "pause",
  description: "Pause a running task (or all running tasks)",

  async run(args: string[]) {
    const db = getDb();

    // Parse arguments
    let taskId = "";
    let pauseAll = false;

    for (const arg of args) {
      if (arg === "--all" || arg === "-a") {
        pauseAll = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(pauseCommand.help?.() ?? "");
        return;
      } else if (!taskId) {
        taskId = arg;
      } else {
        ui.warn(`Unexpected argument: ${arg}`);
      }
    }

    // Handle --all: pause every running task
    if (pauseAll) {
      const runningTasks = db.tasksByStatus("running");
      if (runningTasks.length === 0) {
        ui.info("No running tasks to pause.");
        return;
      }

      let count = 0;
      for (const task of runningTasks) {
        await pauseTask(task.id, db);
        count++;
      }

      ui.success(`Paused ${count} task(s).`);
      return;
    }

    // Single task mode
    if (!taskId) {
      ui.die("Usage: grove pause TASK_ID  (or grove pause --all)");
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    // Verify task is running
    const task = db.taskGet(taskId)!;
    if (task.status !== "running") {
      ui.die(`Task ${taskId} is '${task.status}', not 'running'. Only running tasks can be paused.`);
    }

    await pauseTask(taskId, db);
  },

  help() {
    return `Usage: grove pause TASK_ID
       grove pause --all

Pause a running task. The worker process is stopped and the
current state is saved for later resumption with "grove resume".

Grove captures:
  - Session summary (from .grove/session-summary.md if written)
  - Modified files (via git diff)
  - Cost and token usage from the session log

Options:
  --all, -a    Pause all currently running tasks

Examples:
  grove pause W-005      Pause a specific task
  grove pause --all      Pause all running tasks`;
  },
};

/**
 * Internal: pause a single task by ID. Assumes it exists and is running.
 * - Sends SIGTERM to worker PID (waits 5s, then SIGKILL if still alive)
 * - Reads .grove/session-summary.md from worktree
 * - Captures files modified via git diff + git ls-files --others
 * - Parses cost from stream-json log
 * - Updates task and session records
 */
async function pauseTask(taskId: string, db: Database): Promise<void> {
  const task = db.taskGet(taskId)!;
  const title = task.title;

  ui.info(`Pausing ${taskId}: ${title}`);

  // Find the active session and its worker PID
  const session = db.sessionGetRunning(taskId);
  const sessionId = session?.id ?? null;
  const workerPid = session?.pid ?? null;

  // Signal the worker to stop
  if (workerPid && isAlive(workerPid)) {
    ui.debug(`Sending SIGTERM to worker PID ${workerPid}`);
    try {
      process.kill(workerPid, "SIGTERM");
    } catch {
      // Process may have already exited
    }

    // Wait up to 5 seconds for graceful shutdown
    let waitCount = 0;
    while (isAlive(workerPid) && waitCount < 10) {
      await sleep(500);
      waitCount++;
    }

    // Force kill if still alive
    if (isAlive(workerPid)) {
      ui.debug("Worker still alive, sending SIGKILL");
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  // Read session summary from worktree if it exists
  const worktreePath = task.worktree_path;
  let sessionSummary = "";
  if (worktreePath) {
    const summaryFile = join(worktreePath, ".grove", "session-summary.md");
    if (existsSync(summaryFile)) {
      try {
        sessionSummary = readFileSync(summaryFile, "utf-8");
        ui.debug(`Read session summary from ${summaryFile}`);
      } catch {
        // ignore
      }
    }
  }

  // Get files modified via git diff in worktree
  let filesModified = "";
  if (worktreePath && existsSync(worktreePath)) {
    // Tracked changes
    const diffResult = Bun.spawnSync(
      ["git", "diff", "--name-only", "HEAD"],
      { cwd: worktreePath },
    );
    filesModified = diffResult.stdout.toString().trim();

    if (!filesModified) {
      const diffResult2 = Bun.spawnSync(
        ["git", "diff", "--name-only"],
        { cwd: worktreePath },
      );
      filesModified = diffResult2.stdout.toString().trim();
    }

    // Include untracked files
    const untrackedResult = Bun.spawnSync(
      ["git", "ls-files", "--others", "--exclude-standard"],
      { cwd: worktreePath },
    );
    const untracked = untrackedResult.stdout.toString().trim();

    if (untracked) {
      filesModified = filesModified ? `${filesModified}\n${untracked}` : untracked;
    }
  }

  // Parse cost from the session log if available
  let logFile = "";
  if (sessionId) {
    const logRow = db.get<{ output_log: string | null }>(
      "SELECT output_log FROM sessions WHERE id = ?",
      [sessionId],
    );
    logFile = logRow?.output_log ?? "";
  }

  let costUsd = 0;
  let totalTokens = 0;
  if (logFile && existsSync(logFile)) {
    const costResult = parseCost(logFile);
    costUsd = costResult.costUsd;
    totalTokens = costResult.inputTokens + costResult.outputTokens;
  }

  // Update task: status, session_summary, files_modified, paused_at
  db.taskSetStatus(taskId, "paused");
  db.taskSet(taskId, "paused_at", new Date().toISOString().replace("T", " ").slice(0, 19));

  if (sessionSummary) {
    db.taskSet(taskId, "session_summary", sessionSummary);
  }
  if (filesModified) {
    db.taskSet(taskId, "files_modified", filesModified);
  }

  // Update task cost (accumulate)
  if (costUsd > 0) {
    db.exec(
      "UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + ?, tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?",
      [costUsd, totalTokens, taskId],
    );
  }

  // End the session
  if (sessionId) {
    db.exec(
      "UPDATE sessions SET ended_at = datetime('now'), status = 'paused', cost_usd = ?, tokens_used = ? WHERE id = ?",
      [costUsd, totalTokens, sessionId],
    );
    if (sessionSummary) {
      db.exec(
        "UPDATE sessions SET summary = ? WHERE id = ?",
        [sessionSummary, sessionId],
      );
    }
  }

  // Log paused event
  db.addEvent(taskId, "paused", `Task paused (session ${sessionId ?? "none"}, cost: $${costUsd.toFixed(2)})`);

  ui.success(`Paused ${taskId}`);
  if (filesModified) {
    const fileCount = filesModified.split("\n").filter(Boolean).length;
    console.log(`  ${ui.dim("Files modified:")} ${fileCount}`);
  }
  if (sessionSummary) {
    console.log(`  ${ui.dim("Session summary:")} saved`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
