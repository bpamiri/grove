// grove cost — Cost breakdown and budget comparison
import { getDb } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import type { Command } from "../types";

export const costCommand: Command = {
  name: "cost",
  description: "Cost breakdown and budget comparison",

  async run(args: string[]) {
    const db = getDb();

    let period = "week";

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
      } else if (arg === "--month") {
        period = "month";
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    // Compute date filter
    let dateFilter: string;
    let periodLabel: string;
    if (period === "today") {
      dateFilter = "date(started_at) = date('now')";
      periodLabel = "Today";
    } else if (period === "month") {
      dateFilter = "started_at >= date('now', '-30 days')";
      periodLabel = "Past 30 days";
    } else {
      dateFilter = "started_at >= date('now', 'weekday 1', '-7 days')";
      periodLabel = "This week";
    }

    ui.header(`Cost Report — ${periodLabel}`);

    // Total spend
    const totalCost = period === "today"
      ? db.costToday()
      : period === "week"
        ? db.costWeek()
        : db.scalar<number>(
            `SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE ${dateFilter}`,
          ) ?? 0;

    console.log(`Total: ${ui.bold(ui.dollars(totalCost))}`);
    console.log();

    // Budget comparison
    const dayBudget = budgetGet("per_day");
    const weekBudget = budgetGet("per_week");
    const taskBudget = budgetGet("per_task");

    const todayCost = db.costToday();
    const weekCost = db.costWeek();

    console.log("Budget:");
    if (dayBudget > 0) {
      const dayPct = Math.round((todayCost / dayBudget) * 100);
      const dayBar = progressBar(dayPct);
      console.log(`  Daily:  ${ui.dollars(todayCost)} / ${ui.dollars(dayBudget)}  ${dayBar} ${dayPct}%`);
    }
    if (weekBudget > 0) {
      const weekPct = Math.round((weekCost / weekBudget) * 100);
      const weekBar = progressBar(weekPct);
      console.log(`  Weekly: ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)}  ${weekBar} ${weekPct}%`);
    }
    if (taskBudget > 0) {
      console.log(`  Per-task limit: ${ui.dollars(taskBudget)}`);
    }
    console.log();

    // Cost by repo
    const byRepo = db.all<{ repo: string; total: number }>(
      `SELECT COALESCE(repo, 'unknown') as repo, SUM(cost_usd) as total FROM sessions WHERE ${dateFilter} GROUP BY repo ORDER BY total DESC`,
    );

    if (byRepo.length > 0) {
      console.log("By repo:");
      for (const row of byRepo) {
        console.log(`  ${ui.pad(row.repo, 16)} ${ui.dollars(row.total)}`);
      }
      console.log();
    }

    // Cost by strategy
    const byStrategy = db.all<{ strategy: string; total: number }>(
      `SELECT COALESCE(t.strategy, 'none') as strategy, SUM(s.cost_usd) as total
       FROM sessions s
       LEFT JOIN tasks t ON s.task_id = t.id
       WHERE s.${dateFilter}
       GROUP BY t.strategy
       ORDER BY total DESC`,
    );

    if (byStrategy.length > 0) {
      console.log("By strategy:");
      for (const row of byStrategy) {
        console.log(`  ${ui.pad(row.strategy, 16)} ${ui.dollars(row.total)}`);
      }
      console.log();
    }

    // Most/least expensive tasks
    const mostExpensive = db.all<{ id: string; title: string; cost_usd: number }>(
      `SELECT id, title, cost_usd FROM tasks WHERE cost_usd > 0 ORDER BY cost_usd DESC LIMIT 5`,
    );

    if (mostExpensive.length > 0) {
      console.log("Most expensive tasks:");
      for (const t of mostExpensive) {
        console.log(`  ${ui.pad(t.id, 10)} ${ui.dollars(t.cost_usd)}  ${ui.truncate(t.title, 40)}`);
      }
      console.log();
    }

    const leastExpensive = db.all<{ id: string; title: string; cost_usd: number }>(
      `SELECT id, title, cost_usd FROM tasks WHERE cost_usd > 0 AND status = 'completed' ORDER BY cost_usd ASC LIMIT 5`,
    );

    if (leastExpensive.length > 0) {
      console.log("Least expensive completed tasks:");
      for (const t of leastExpensive) {
        console.log(`  ${ui.pad(t.id, 10)} ${ui.dollars(t.cost_usd)}  ${ui.truncate(t.title, 40)}`);
      }
    }
  },

  help() {
    return [
      "Usage: grove cost [--today|--week|--month]",
      "",
      "Show cost breakdown and budget comparison.",
      "",
      "Options:",
      "  --today    Costs for today only",
      "  --week     Costs for this week (default)",
      "  --month    Costs for the past 30 days",
      "",
      "Displays:",
      "  - Total spend for the period",
      "  - Budget usage (daily, weekly, per-task limits)",
      "  - Breakdown by repo and strategy",
      "  - Most/least expensive tasks",
    ].join("\n");
  },
};

function progressBar(pct: number): string {
  const width = 20;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  if (pct >= 90) return ui.pc.red(bar);
  if (pct >= 70) return ui.pc.yellow(bar);
  return ui.pc.green(bar);
}
