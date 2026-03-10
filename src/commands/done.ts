// grove done — Mark a task as completed
import { existsSync } from "node:fs";
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import { EventType, TaskStatus } from "../types";
import type { Command } from "../types";

export const doneCommand: Command = {
  name: "done",
  description: "Mark a task as completed",

  async run(args: string[]) {
    const db = getDb();

    let taskId = "";
    let force = false;

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
        taskId = arg;
        i++;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    if (!taskId) {
      ui.die("Usage: grove done TASK_ID [--force]");
    }

    const task = db.taskGet(taskId);
    if (!task) {
      ui.die(`Task '${taskId}' not found.`);
      return; // unreachable, but helps TS narrow
    }

    // Validate status
    const validStatuses = [TaskStatus.Done, TaskStatus.Review];
    if (!force && !validStatuses.includes(task.status as TaskStatus)) {
      ui.die(
        `Task ${taskId} is '${task.status}'. Expected 'done' or 'review'. Use --force to override.`,
      );
    }

    // Check PR merge status if task has a PR
    if (task.pr_number && task.repo && !force) {
      const repoConfigs = configRepoDetail();
      const rc = repoConfigs[task.repo];
      if (rc) {
        const ghRepo = rc.github || `${rc.org}/${task.repo}`;
        const result = Bun.spawnSync([
          "gh", "pr", "view", String(task.pr_number),
          "--repo", ghRepo,
          "--json", "state",
        ]);

        if (result.exitCode === 0) {
          try {
            const prData = JSON.parse(result.stdout.toString());
            if (prData.state !== "MERGED") {
              ui.die(
                `PR #${task.pr_number} is not merged (state: ${prData.state}). Use --force to override.`,
              );
            }
          } catch {
            ui.warn("Could not parse PR status; continuing.");
          }
        } else {
          ui.warn("Could not check PR status; continuing.");
        }
      }
    }

    // Mark completed
    db.taskSetStatus(taskId, TaskStatus.Completed);
    db.taskSet(taskId, "completed_at", new Date().toISOString());
    db.addEvent(taskId, EventType.Completed, "Task marked as completed");

    // Cleanup worktree if it exists
    if (task.worktree_path && existsSync(task.worktree_path)) {
      ui.info(`Cleaning up worktree: ${task.worktree_path}`);
      const rmResult = Bun.spawnSync(["git", "worktree", "remove", task.worktree_path, "--force"], {
        cwd: task.worktree_path,
      });
      if (rmResult.exitCode === 0) {
        db.taskSet(taskId, "worktree_path", null);
        ui.success("Worktree removed.");
      } else {
        ui.warn(`Worktree cleanup failed: ${rmResult.stderr.toString().trim()}`);
      }
    }

    // Show summary
    ui.success(`Task ${taskId} completed.`);
    console.log();

    const costStr = task.cost_usd > 0 ? ui.dollars(task.cost_usd) : "-";
    const timeStr = task.time_minutes > 0 ? ui.formatDuration(task.time_minutes) : "-";

    const startedAt = task.started_at ? new Date(task.started_at.replace(" ", "T") + "Z") : null;
    const elapsed = startedAt
      ? ui.formatDuration((Date.now() - startedAt.getTime()) / 60000)
      : "-";

    console.log(`  ${ui.dim("Task:")}      ${task.id} — ${task.title}`);
    console.log(`  ${ui.dim("Repo:")}      ${task.repo || "-"}`);
    console.log(`  ${ui.dim("Cost:")}      ${costStr}`);
    console.log(`  ${ui.dim("Work time:")} ${timeStr}`);
    console.log(`  ${ui.dim("Elapsed:")}   ${elapsed}`);
    if (task.pr_url) {
      console.log(`  ${ui.dim("PR:")}        ${task.pr_url}`);
    }
  },

  help() {
    return [
      "Usage: grove done TASK_ID [--force]",
      "",
      "Mark a task as completed.",
      "",
      "Validates that the task is in 'done' or 'review' status and",
      "checks the associated PR merge status (if any).",
      "",
      "Options:",
      "  --force, -f    Skip status and PR checks",
      "",
      "On completion:",
      "  - Sets status to 'completed' with timestamp",
      "  - Cleans up worktree if present",
      "  - Shows cost and time summary",
    ].join("\n");
  },
};
