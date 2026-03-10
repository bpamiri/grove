// grove msg — Queue a message for a running worker
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { getDb, getEnv } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { lastActivity, isAlive } from "../lib/monitor";
import type { Command, Task, Session, Event } from "../types";

export const msgCommand: Command = {
  name: "msg",
  description: "Queue a message for a running worker",

  async run(args: string[]) {
    const db = getDb();
    const { GROVE_LOG_DIR } = getEnv();

    const taskId = args[0];
    const message = args.slice(1).join(" ");

    if (!taskId) {
      ui.die('Usage: grove msg TASK_ID "message text"');
    }

    if (!message) {
      ui.die('Usage: grove msg TASK_ID "message text"');
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    // Verify task is running
    const task = db.taskGet(taskId)!;
    if (task.status !== "running") {
      ui.die(
        `Task ${taskId} is not running (status: ${task.status}). Messages can only be sent to running tasks.`,
      );
    }

    // Ensure log directory exists
    if (!existsSync(GROVE_LOG_DIR)) {
      mkdirSync(GROVE_LOG_DIR, { recursive: true });
    }

    // Write message to the message file
    const msgFile = `${GROVE_LOG_DIR}/${taskId}.msg`;
    const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    appendFileSync(msgFile, `[${ts}] ${message}\n`);

    // Log event
    db.addEvent(
      taskId,
      "message_sent",
      `Message queued: ${ui.truncate(message, 80)}`,
    );

    ui.success(`Message queued for ${taskId}`);
    console.log(`  ${ui.dim("Task:")}    ${ui.truncate(task.title, 50)}`);
    console.log(`  ${ui.dim("Message:")} ${ui.truncate(message, 60)}`);
    console.log(`  ${ui.dim("File:")}    ${msgFile}`);
    console.log();
    console.log(
      ui.dim(
        "Note: Message will be read when the task is next resumed or",
      ),
    );
    console.log(
      ui.dim(
        "interacted with. Claude Code -p sessions do not accept live input.",
      ),
    );
  },

  help() {
    return `Usage: grove msg TASK_ID "message text"

Queue a message for a running worker.

Since Claude Code -p sessions do not accept live input,
messages are written to a file that gets read when the
task is resumed or the worker checks for messages.

Multiple messages can be queued -- they are appended with
timestamps.

Examples:
  grove msg W-001 "Focus on the test failures first"
  grove msg W-001 "Skip the linting for now"`;
  },
};
