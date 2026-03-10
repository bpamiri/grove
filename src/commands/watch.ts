// grove watch — Tail a worker's output log with formatted display
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { getDb, getEnv } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { lastActivity, isAlive, formatStreamLine } from "../lib/monitor";
import type { Command, Task, Session, Event } from "../types";

/** Find the log file for a task: sessions table first, then glob */
function findLogFile(taskId: string): string | null {
  const db = getDb();
  const { GROVE_LOG_DIR } = getEnv();

  // Try sessions table first
  const session = db.get<{ output_log: string | null }>(
    "SELECT output_log FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    [taskId],
  );

  if (session?.output_log && existsSync(session.output_log)) {
    return session.output_log;
  }

  // Fallback: glob GROVE_LOG_DIR for {task_id}*.log
  if (existsSync(GROVE_LOG_DIR)) {
    const result = Bun.spawnSync(["sh", "-c", `ls -1 "${GROVE_LOG_DIR}/${taskId}"-*.log 2>/dev/null | tail -1`]);
    const found = result.stdout.toString().trim();
    if (found && existsSync(found)) {
      return found;
    }
  }

  // Also check plain {task_id}.log
  const plainLog = `${GROVE_LOG_DIR}/${taskId}.log`;
  if (existsSync(plainLog)) {
    return plainLog;
  }

  return null;
}

/** Colorize a formatted stream event line for terminal output */
function colorize(type: string, text: string): string {
  switch (type) {
    case "tool_use":
      return `  \x1b[0;34m${text}\x1b[0m`;
    case "tool_result":
      return `  \x1b[2m${text}\x1b[0m`;
    case "error":
      return `  \x1b[0;31m${text}\x1b[0m`;
    case "system":
    case "info":
      return `  \x1b[2m${text}\x1b[0m`;
    case "result":
      return `  \x1b[1;32m${text}\x1b[0m`;
    default:
      return text;
  }
}

export const watchCommand: Command = {
  name: "watch",
  description: "Tail a running worker's output log with formatted display",

  async run(args: string[]) {
    const db = getDb();
    const taskId = args[0];

    if (!taskId) {
      ui.die("Usage: grove watch TASK_ID");
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    // Check task is running
    const task = db.taskGet(taskId)!;
    if (task.status !== "running") {
      ui.die(
        `Task ${taskId} is not running (status: ${task.status}). Only running tasks can be watched.`,
      );
    }

    // Find log file
    const logFile = findLogFile(taskId);
    if (!logFile) {
      ui.die(`No log file found for task ${taskId}`);
    }

    const title = ui.truncate(task.title, 50);
    console.log(`${ui.bold(ui.pc.green("Watching"))} ${taskId} -- ${title}`);
    console.log(`${ui.dim("Log:")} ${logFile}`);
    console.log(ui.dim("Press Ctrl+C to stop watching (worker continues)"));
    console.log();

    // Log the watch event
    db.addEvent(taskId, "watched", "Started watching output");

    // Get the terminal width for truncation
    const maxLineLen = process.stdout.columns || 120;

    // Tail the file using polling (read new bytes periodically)
    let offset = 0;
    let remainder = ""; // partial line buffer

    // Start from end of file if it's already large (show last 50 lines worth)
    const stat = statSync(logFile);
    if (stat.size > 10000) {
      // Start near the end — read last ~10KB for context
      offset = Math.max(0, stat.size - 10000);
    }

    let stopped = false;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(pollInterval);
      console.log(
        `\n${ui.bold(ui.pc.yellow("Stopped watching."))} Worker continues in background.`,
      );
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    const pollInterval = setInterval(() => {
      if (stopped) return;

      if (!existsSync(logFile)) return;

      const currentStat = statSync(logFile);
      if (currentStat.size <= offset) return;

      // Read new bytes
      const fd = openSync(logFile, "r");
      const bytesToRead = currentStat.size - offset;
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, offset);
      closeSync(fd);
      offset = currentStat.size;

      // Process new data line by line
      const chunk = remainder + buffer.toString("utf-8");
      const lines = chunk.split("\n");

      // Last element may be an incomplete line
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        const event = formatStreamLine(line);
        if (event) {
          let output = colorize(event.type, event.text);
          // Truncate long lines
          if (output.length > maxLineLen + 20) {
            // +20 for ANSI codes
            output = output.slice(0, maxLineLen + 17) + "...";
          }
          process.stdout.write(output + "\n");
        }
      }
    }, 200);

    // Keep the process alive until Ctrl+C
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (stopped) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  },

  help() {
    return `Usage: grove watch TASK_ID

Tail a running worker's output log with formatted display.

Shows tool usage, file edits, and text output in a
human-readable format. JSON stream lines are parsed
and colorized.

Press Ctrl+C to stop watching -- the worker continues
running in the background.

Examples:
  grove watch W-001    Watch worker output for task W-001`;
  },
};
