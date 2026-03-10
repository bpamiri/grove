// grove tasks — List tasks with optional filters
import { getDb } from "../core/db";
import * as ui from "../core/ui";
import type { Command, Task } from "../types";

export const tasksCommand: Command = {
  name: "tasks",
  description: "List tasks with optional filters",

  async run(args: string[]) {
    const db = getDb();

    let showAll = false;
    let filterStatus = "";
    let filterRepo = "";

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--all" || arg === "-a") {
        showAll = true;
        i++;
      } else if ((arg === "--status" || arg === "-s") && i + 1 < args.length) {
        filterStatus = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--status=")) {
        filterStatus = arg.slice("--status=".length);
        i++;
      } else if ((arg === "--repo" || arg === "-r") && i + 1 < args.length) {
        filterRepo = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--repo=")) {
        filterRepo = arg.slice("--repo=".length);
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    // Build query
    const conditions: string[] = [];
    const params: any[] = [];

    if (!showAll && !filterStatus) {
      conditions.push("status != 'completed'");
    }

    if (filterStatus) {
      conditions.push("status = ?");
      params.push(filterStatus);
    }

    if (filterRepo) {
      conditions.push("repo = ?");
      params.push(filterRepo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM tasks ${where} ORDER BY priority ASC, created_at ASC`;
    const tasks = db.all<Task>(sql, params);

    if (tasks.length === 0) {
      if (filterStatus || filterRepo) {
        ui.info("No tasks match the given filters.");
      } else {
        ui.info("No tasks yet. Run 'grove add' to create one.");
      }
      return;
    }

    // Header
    ui.header("Tasks");

    console.log(
      `${ui.bold(ui.pad("ID", 8))} ${ui.bold(ui.pad("REPO", 12))} ${ui.bold(ui.pad("TITLE", 30))} ${ui.bold(ui.pad("STATUS", 12))} ${ui.bold(ui.pad("STRATEGY", 10))} ${ui.bold("COST")}`,
    );
    console.log(
      `${"--------"} ${"------------"} ${"------------------------------"} ${"------------"} ${"----------"} ${"--------"}`,
    );

    for (const task of tasks) {
      const displayTitle = ui.truncate(task.title, 28);
      const statusDisplay = ui.statusBadge(task.status);
      const stratDisplay = task.strategy || "-";

      // Cost: show actual if > 0, else ~estimated
      let costDisplay = "-";
      if (task.cost_usd > 0) {
        costDisplay = ui.dollars(task.cost_usd);
      } else if (task.estimated_cost != null) {
        costDisplay = `~${ui.dollars(task.estimated_cost)}`;
      }

      // Pad status badge manually (ANSI codes break simple padding)
      const visibleLen = task.status.length + 2; // [status]
      const padNeeded = Math.max(1, 12 - visibleLen);
      const badgePadded = statusDisplay + " ".repeat(padNeeded);

      console.log(
        `${ui.pad(task.id, 8)} ${ui.pad(task.repo || "-", 12)} ${ui.pad(displayTitle, 30)} ${badgePadded}${ui.pad(stratDisplay, 10)} ${costDisplay}`,
      );
    }

    // Summary
    const total = db.taskCount();
    console.log(`\n${ui.dim(`${tasks.length} task(s) shown, ${total} total`)}`);
  },

  help() {
    return [
      "Usage: grove tasks [OPTIONS]",
      "",
      "List tasks with optional filters.",
      "",
      "Options:",
      "  --all, -a           Include completed tasks",
      "  --status STATUS     Filter by status",
      "  --repo REPO         Filter by repo name",
      "",
      "Statuses: ingested, planned, ready, running, paused, done, failed, review, completed",
      "",
      "Examples:",
      "  grove tasks                  Show all active tasks",
      "  grove tasks --all            Include completed",
      "  grove tasks --status ready   Show only ready tasks",
      "  grove tasks --repo wheels    Show tasks for wheels repo",
    ].join("\n");
  },
};
