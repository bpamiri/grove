// grove close — Close/abandon a task
import { existsSync } from "node:fs";
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { EventType, TaskStatus } from "../types";
import type { Command } from "../types";

export const closeCommand: Command = {
  name: "close",
  description: "Close/abandon a task",

  async run(args: string[]) {
    const db = getDb();

    let taskId = "";
    let cleanup = false;
    let force = false;

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--cleanup") {
        cleanup = true;
        i++;
      } else if (arg === "--force" || arg === "-f") {
        force = true;
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else if (!arg.startsWith("-")) {
        taskId = arg;
        i++;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    if (!taskId) {
      ui.die("Usage: grove close TASK_ID [--cleanup] [--force]");
    }

    const task = db.taskGet(taskId);
    if (!task) {
      ui.die(`Task '${taskId}' not found.`);
      return;
    }

    if (task.status === TaskStatus.Completed) {
      ui.die(`Task ${taskId} is already completed. Nothing to close.`);
    }

    // Multi-step confirmation unless --force
    if (!force) {
      console.log();
      console.log(`  Task:   ${task.id} — ${task.title}`);
      console.log(`  Repo:   ${task.repo || "-"}`);
      console.log(`  Status: ${ui.statusBadge(task.status)}`);
      if (task.pr_url) console.log(`  PR:     ${task.pr_url}`);
      console.log();

      const confirmed = await prompts.confirm(`Close task ${taskId}? This sets status to 'failed'.`);
      if (!confirmed) {
        ui.info("Cancelled.");
        return;
      }
    }

    // Kill running worker if active
    if (task.status === TaskStatus.Running) {
      const session = db.sessionGetRunning(taskId);
      if (session?.pid) {
        ui.info(`Killing worker PID ${session.pid}...`);
        try {
          process.kill(session.pid, "SIGTERM");
          ui.success("Worker terminated.");
        } catch {
          ui.warn(`Could not kill PID ${session.pid} (may already be dead).`);
        }
        db.sessionEnd(session.id, "killed");
      }
    }

    // Optionally remove worktree
    if (task.worktree_path && existsSync(task.worktree_path)) {
      let removeWorktree = cleanup;
      if (!cleanup && !force) {
        removeWorktree = await prompts.confirm("Remove worktree?");
      }
      if (removeWorktree) {
        ui.info(`Removing worktree: ${task.worktree_path}`);
        const res = Bun.spawnSync(["git", "worktree", "remove", task.worktree_path, "--force"], {
          cwd: task.worktree_path,
        });
        if (res.exitCode === 0) {
          db.taskSet(taskId, "worktree_path", null);
          ui.success("Worktree removed.");
        } else {
          ui.warn(`Worktree removal failed: ${res.stderr.toString().trim()}`);
        }
      }
    }

    // Optionally close GitHub PR
    if (task.pr_number && task.repo) {
      let closePr = force;
      if (!force) {
        closePr = await prompts.confirm(`Close PR #${task.pr_number}?`);
      }
      if (closePr) {
        const repoConfigs = configRepoDetail();
        const rc = repoConfigs[task.repo];
        if (rc) {
          const ghRepo = rc.github || `${rc.org}/${task.repo}`;
          const res = Bun.spawnSync([
            "gh", "pr", "close", "--repo", ghRepo, String(task.pr_number),
          ]);
          if (res.exitCode === 0) {
            ui.success(`PR #${task.pr_number} closed.`);
          } else {
            ui.warn(`PR close failed: ${res.stderr.toString().trim()}`);
          }
        }
      }
    }

    // Set status to failed
    db.taskSetStatus(taskId, TaskStatus.Failed);
    db.addEvent(taskId, EventType.Failed, "Task closed/abandoned");

    ui.success(`Task ${taskId} closed.`);
  },

  help() {
    return [
      "Usage: grove close TASK_ID [--cleanup] [--force]",
      "",
      "Close/abandon a task, setting its status to 'failed'.",
      "",
      "Options:",
      "  --cleanup    Also remove the worktree",
      "  --force, -f  Skip all confirmations",
      "",
      "Actions:",
      "  - Kills running worker if active",
      "  - Optionally removes worktree (prompted, or --cleanup)",
      "  - Optionally closes the GitHub PR (prompted, or --force)",
      "  - Sets status to 'failed'",
    ].join("\n");
  },
};
