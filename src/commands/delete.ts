// grove delete — Permanently delete a task and all its related records
import { getDb } from "../core/db";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import type { Command } from "../types";

export const deleteCommand: Command = {
  name: "delete",
  description: "Permanently delete a task",

  async run(args: string[]) {
    const db = getDb();

    let force = false;
    const taskIds: string[] = [];

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--force" || arg === "-f") {
        force = true;
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else if (!arg.startsWith("-")) {
        taskIds.push(arg);
        i++;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    if (taskIds.length === 0) {
      ui.die("Usage: grove delete TASK_ID [...] [--force]");
    }

    // Validate all tasks exist
    const tasks = [];
    for (const id of taskIds) {
      const task = db.taskGet(id);
      if (!task) {
        ui.die(`Task '${id}' not found.`);
        return;
      }
      if (task.status === "running") {
        ui.die(`Task ${id} is running. Pause or cancel it first.`);
        return;
      }
      tasks.push(task);
    }

    // Confirm unless --force
    if (!force) {
      console.log();
      for (const task of tasks) {
        console.log(`  ${ui.statusBadge(task.status)} ${task.id}  ${task.title}`);
      }
      console.log();
      const confirmed = await prompts.confirm(
        `Permanently delete ${tasks.length} task(s)? This cannot be undone.`,
      );
      if (!confirmed) {
        ui.info("Cancelled.");
        return;
      }
    }

    // Delete related records then the task itself
    for (const task of tasks) {
      db.exec("DELETE FROM audit_results WHERE task_id = ?", [task.id]);
      db.exec("DELETE FROM sessions WHERE task_id = ?", [task.id]);
      db.exec("DELETE FROM events WHERE task_id = ?", [task.id]);
      db.exec("DELETE FROM tasks WHERE id = ?", [task.id]);
      ui.success(`Deleted ${task.id}: ${task.title}`);
    }
  },

  help() {
    return [
      "Usage: grove delete TASK_ID [...] [--force]",
      "",
      "Permanently delete one or more tasks and all related records",
      "(events, sessions, audit results).",
      "",
      "Options:",
      "  --force, -f  Skip confirmation prompt",
      "",
      "Examples:",
      "  grove delete W-001",
      "  grove delete W-001 W-002 --force",
      "",
      "Running tasks cannot be deleted — pause or cancel them first.",
      "To abandon a task without deleting, use: grove close TASK_ID",
    ].join("\n");
  },
};
