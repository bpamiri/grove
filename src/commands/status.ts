// grove status — Non-interactive text summary, pipe-friendly
import { existsSync } from "node:fs";
import { getDb, getEnv } from "../core/db";
import { workspaceName, budgetGet } from "../core/config";
import * as ui from "../core/ui";
import type { Command, Task, Event } from "../types";

export const statusCommand: Command = {
  name: "status",
  description: "Quick non-interactive status summary",

  async run() {
    const { GROVE_DB } = getEnv();
    if (!existsSync(GROVE_DB)) {
      ui.die("Grove not initialized. Run 'grove init' first.");
    }

    const db = getDb();
    const wsName = workspaceName();

    console.log(`${ui.bold(wsName)}  ${ui.dim("status")}`);
    console.log();

    // --- Counts ---
    const total = db.taskCount();
    const running = db.taskCount("running");
    const paused = db.taskCount("paused");
    const ready = db.taskCount("ready");
    const review = db.taskCount("review");
    const ingested = db.taskCount("ingested");
    const planned = db.taskCount("planned");
    const failed = db.taskCount("failed");
    const doneCount =
      db.scalar<number>(
        "SELECT COUNT(*) FROM tasks WHERE status IN ('completed', 'done')",
      ) ?? 0;

    if (total === 0) {
      console.log('No tasks. Run "grove add" or "grove sync" to get started.');
      return;
    }

    // Summary line
    let summary = `Tasks: ${total} total`;
    if (running > 0) summary += `, ${ui.pc.green(`${running} running`)}`;
    if (paused > 0) summary += `, ${ui.pc.yellow(`${paused} paused`)}`;
    if (ready > 0) summary += `, ${ready} ready`;
    if (review > 0) summary += `, ${review} in review`;
    if (ingested > 0) summary += `, ${ingested} ingested`;
    if (planned > 0) summary += `, ${planned} planned`;
    if (failed > 0) summary += `, ${ui.pc.red(`${failed} failed`)}`;
    if (doneCount > 0) summary += `, ${doneCount} done`;
    console.log(summary);
    console.log();

    // --- Running tasks ---
    if (running > 0) {
      console.log("Running:");
      const rows = db.tasksByStatus("running");
      for (const t of rows) {
        console.log(
          `  ${t.id}  ${(t.repo ?? "").padEnd(8)}  ${ui.truncate(t.title, 50)}`,
        );
      }
      console.log();
    }

    // --- Paused tasks ---
    if (paused > 0) {
      console.log("Paused:");
      const rows = db.tasksByStatus("paused");
      for (const t of rows) {
        console.log(
          `  ${t.id}  ${(t.repo ?? "").padEnd(8)}  ${ui.truncate(t.title, 50)}`,
        );
      }
      console.log();
    }

    // --- Ready tasks ---
    if (ready > 0) {
      console.log("Ready:");
      const rows = db.tasksByStatus("ready");
      for (const t of rows) {
        console.log(
          `  ${t.id}  ${(t.repo ?? "").padEnd(8)}  ${ui.truncate(t.title, 50)}`,
        );
      }
      console.log();
    }

    // --- Recent events ---
    const events = db.recentEvents(5);
    if (events.length > 0) {
      console.log("Recent activity:");
      for (const e of events) {
        const rel = ui.relativeTime(e.timestamp);
        const taskStr = e.task_id ? `${e.task_id} ` : "";
        const summaryStr = e.summary ? ui.truncate(e.summary, 50) : "";
        console.log(
          `  ${ui.dim(rel.padEnd(16))} ${taskStr}${summaryStr}`,
        );
      }
      console.log();
    }

    // --- Budget ---
    const todayCost = db.costToday();
    const weekCost = db.costWeek();
    const weekBudget = budgetGet("per_week");
    console.log(
      `Budget: ${ui.dollars(todayCost)} today, ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)} this week`,
    );
  },

  help() {
    return `Usage: grove status

Show a quick non-interactive text summary of all tasks.

Displays:
  - Task counts by status
  - Running and paused task details
  - Ready tasks
  - Last 5 events
  - Budget summary

Suitable for piping or scripting. For the interactive
dashboard, run: grove`;
  },
};
