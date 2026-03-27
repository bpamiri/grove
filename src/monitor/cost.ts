// Grove v3 — Cost monitor
// Tracks spend per task/day/week, enforces budget limits.
import { bus } from "../broker/event-bus";
import type { Database } from "../broker/db";
import type { BudgetConfig } from "../shared/types";

interface CostMonitorOptions {
  db: Database;
  budgets: BudgetConfig;
  intervalMs?: number;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let spawningPaused = false;

export function startCostMonitor(opts: CostMonitorOptions): void {
  const { db, budgets, intervalMs = 30_000 } = opts;

  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    checkBudgets(db, budgets);
  }, intervalMs);

  // Also check immediately
  checkBudgets(db, budgets);
}

export function stopCostMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Check if worker spawning is currently paused due to budget */
export function isSpawningPaused(): boolean {
  return spawningPaused;
}

/** Check a specific task's cost against per-task budget */
export function checkTaskBudget(taskId: string, db: Database, budgets: BudgetConfig): {
  ok: boolean;
  current: number;
  limit: number;
} {
  const task = db.taskGet(taskId);
  const current = task?.cost_usd ?? 0;
  return {
    ok: current < budgets.per_task,
    current,
    limit: budgets.per_task,
  };
}

function checkBudgets(db: Database, budgets: BudgetConfig): void {
  const today = db.costToday();
  const week = db.costWeek();

  // Daily budget
  if (today >= budgets.per_day) {
    if (!spawningPaused) {
      spawningPaused = true;
      bus.emit("cost:budget_exceeded", {
        current: today,
        limit: budgets.per_day,
        period: "daily",
      });
    }
  } else if (today >= budgets.per_day * 0.8) {
    bus.emit("cost:budget_warning", {
      current: today,
      limit: budgets.per_day,
      period: "daily",
    });
  }

  // Weekly budget
  if (week >= budgets.per_week) {
    if (!spawningPaused) {
      spawningPaused = true;
      bus.emit("cost:budget_exceeded", {
        current: week,
        limit: budgets.per_week,
        period: "weekly",
      });
    }
  } else if (week >= budgets.per_week * 0.8) {
    bus.emit("cost:budget_warning", {
      current: week,
      limit: budgets.per_week,
      period: "weekly",
    });
  }

  // Unpause if we're back under both limits
  if (spawningPaused && today < budgets.per_day && week < budgets.per_week) {
    spawningPaused = false;
  }
}
