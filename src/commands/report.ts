// grove report — Generate markdown activity summary
import { writeFileSync } from "node:fs";
import { getDb } from "../core/db";
import { workspaceName, budgetGet } from "../core/config";
import * as ui from "../core/ui";
import type { Command, Task, Event } from "../types";

function dateRange(period: string): { start: string; label: string } {
  const now = new Date();
  if (period === "today") {
    const d = now.toISOString().slice(0, 10);
    return { start: d, label: `Today (${d})` };
  }
  // Default: week
  const weekAgo = new Date(now.getTime() - 7 * 86400 * 1000);
  return {
    start: weekAgo.toISOString().slice(0, 10),
    label: `Week of ${weekAgo.toISOString().slice(0, 10)}`,
  };
}

export const reportCommand: Command = {
  name: "report",
  description: "Generate markdown activity summary",

  async run(args: string[]) {
    const db = getDb();

    let period = "week";
    let outputFile = "";

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--today") {
        period = "today";
        i++;
      } else if (arg === "--week") {
        period = "week";
        i++;
      } else if ((arg === "--output" || arg === "-o") && i + 1 < args.length) {
        outputFile = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--output=")) {
        outputFile = arg.slice("--output=".length);
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    const { start, label } = dateRange(period);
    const wsName = workspaceName();

    // Gather data
    const completed = db.all<Task>(
      "SELECT * FROM tasks WHERE status IN ('completed', 'done') AND completed_at >= ? ORDER BY completed_at DESC",
      [start],
    );

    const inProgress = db.all<Task>(
      "SELECT * FROM tasks WHERE status IN ('running', 'paused', 'review') ORDER BY priority ASC",
    );

    const events = db.all<Event>(
      "SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 50",
      [start],
    );

    const totalCost = db.scalar<number>(
      "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE started_at >= ?",
      [start],
    ) ?? 0;

    const costByRepo = db.all<{ repo: string; total: number }>(
      "SELECT COALESCE(repo, 'unknown') as repo, SUM(cost_usd) as total FROM sessions WHERE started_at >= ? GROUP BY repo ORDER BY total DESC",
      [start],
    );

    const weekBudget = budgetGet("per_week");

    // Build markdown
    const lines: string[] = [];
    lines.push(`# ${wsName} — Activity Report`);
    lines.push(`**Period:** ${label}`);
    lines.push("");

    // Summary counts
    lines.push("## Summary");
    lines.push(`- **Completed:** ${completed.length} task(s)`);
    lines.push(`- **In progress:** ${inProgress.length} task(s)`);
    lines.push(`- **Total cost:** $${totalCost.toFixed(2)}`);
    if (weekBudget > 0) {
      lines.push(`- **Budget:** $${totalCost.toFixed(2)} / $${weekBudget.toFixed(2)} (${Math.round((totalCost / weekBudget) * 100)}%)`);
    }
    lines.push("");

    // Completed tasks table
    if (completed.length > 0) {
      lines.push("## Completed Tasks");
      lines.push("| ID | Repo | Title | Cost | Time |");
      lines.push("|---|---|---|---|---|");
      for (const t of completed) {
        const cost = t.cost_usd > 0 ? `$${t.cost_usd.toFixed(2)}` : "-";
        const time = t.time_minutes > 0 ? `${Math.round(t.time_minutes)}m` : "-";
        lines.push(`| ${t.id} | ${t.repo || "-"} | ${t.title} | ${cost} | ${time} |`);
      }
      lines.push("");
    }

    // In-progress table
    if (inProgress.length > 0) {
      lines.push("## In Progress");
      lines.push("| ID | Repo | Title | Status | Cost |");
      lines.push("|---|---|---|---|---|");
      for (const t of inProgress) {
        const cost = t.cost_usd > 0 ? `$${t.cost_usd.toFixed(2)}` : "-";
        lines.push(`| ${t.id} | ${t.repo || "-"} | ${t.title} | ${t.status} | ${cost} |`);
      }
      lines.push("");
    }

    // Cost breakdown
    if (costByRepo.length > 0) {
      lines.push("## Cost Breakdown");
      lines.push("| Repo | Cost |");
      lines.push("|---|---|");
      for (const row of costByRepo) {
        lines.push(`| ${row.repo} | $${row.total.toFixed(2)} |`);
      }
      lines.push("");
    }

    // Recent events
    if (events.length > 0) {
      lines.push("## Recent Events");
      const displayEvents = events.slice(0, 20);
      for (const e of displayEvents) {
        const taskStr = e.task_id ? `**${e.task_id}**` : "";
        const summaryStr = e.summary || e.event_type;
        lines.push(`- \`${e.timestamp}\` ${taskStr} ${summaryStr}`);
      }
      lines.push("");
    }

    const markdown = lines.join("\n");

    if (outputFile) {
      writeFileSync(outputFile, markdown);
      ui.success(`Report written to ${outputFile}`);
    } else {
      console.log(markdown);
    }
  },

  help() {
    return [
      "Usage: grove report [--today|--week] [--output FILE]",
      "",
      "Generate a markdown activity summary.",
      "",
      "Options:",
      "  --today           Report for today only",
      "  --week            Report for the past 7 days (default)",
      "  --output, -o FILE Write report to file instead of stdout",
      "",
      "Includes:",
      "  - Summary counts (completed, in-progress, costs)",
      "  - Completed tasks table",
      "  - In-progress tasks table",
      "  - Cost breakdown by repo",
      "  - Recent events timeline",
    ].join("\n");
  },
};
