// grove plan — Assign strategy and cost estimates to tasks
import { getDb } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { Strategy, EventType } from "../types";
import type { Command, Task } from "../types";

// ---------------------------------------------------------------------------
// Strategy detection via keyword heuristics
// ---------------------------------------------------------------------------

function detectStrategy(text: string): Strategy {
  const lower = text.toLowerCase();

  // Sweep-type keywords
  if (/audit|check all|validate|review all|scan|lint|check each/.test(lower)) {
    return Strategy.Sweep;
  }

  // Pipeline-type keywords
  if (/cross-repo|cross repo|multiple repos|pipeline|end-to-end|end to end|multi-repo/.test(lower)) {
    return Strategy.Pipeline;
  }

  // Team-type keywords
  if (/refactor|redesign|overhaul|migration|rewrite|rearchitect|large scale|major change/.test(lower)) {
    return Strategy.Team;
  }

  return Strategy.Solo;
}

// ---------------------------------------------------------------------------
// Cost estimation based on strategy
// ---------------------------------------------------------------------------

function estimateTeamSize(text: string): number {
  const lower = text.toLowerCase();
  if (/overhaul|rewrite|rearchitect|large scale|major/.test(lower)) {
    return 3;
  }
  return 2;
}

function estimateCost(strategy: Strategy, text: string): number {
  switch (strategy) {
    case Strategy.Solo:
      return 2;
    case Strategy.Team: {
      const size = estimateTeamSize(text);
      return size * 2;
    }
    case Strategy.Sweep:
      return 3;
    case Strategy.Pipeline:
      return 8;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Plan a single task
// ---------------------------------------------------------------------------

function planTask(db: ReturnType<typeof getDb>, taskId: string): boolean {
  const task = db.taskGet(taskId);
  if (!task) {
    ui.error(`Task not found: ${taskId}`);
    return false;
  }

  // Allow planning from ingested or planned status only
  if (task.status !== "ingested" && task.status !== "planned") {
    ui.warn(`Task ${taskId} is '${task.status}' -- skipping (must be ingested or planned).`);
    return false;
  }

  const fullText = `${task.title} ${task.description || ""}`;

  // Detect strategy
  const strategy = detectStrategy(fullText);

  // Estimate cost
  const estCost = estimateCost(strategy, fullText);

  // Build strategy config for team
  let strategyConfig: string | null = null;
  if (strategy === Strategy.Team) {
    const teamSize = estimateTeamSize(fullText);
    strategyConfig = JSON.stringify({ teamSize });
  }

  // Update task
  db.taskSet(taskId, "strategy", strategy);
  db.taskSet(taskId, "estimated_cost", estCost);
  if (strategyConfig) {
    db.taskSet(taskId, "strategy_config", strategyConfig);
  }
  db.taskSetStatus(taskId, "planned");

  // Log event
  db.addEvent(taskId, EventType.Planned, `Strategy: ${strategy}, Est: ${ui.dollars(estCost)}`);

  ui.success(`Planned ${taskId} (${task.repo || "-"}): strategy=${strategy} est=${ui.dollars(estCost)}`);

  // Auto-promote to ready if under auto_approve threshold
  const autoApprove = budgetGet("auto_approve_under");
  if (autoApprove > 0 && estCost < autoApprove) {
    db.taskSetStatus(taskId, "ready");
    db.addEvent(
      taskId,
      EventType.AutoApproved,
      `Cost ${ui.dollars(estCost)} under auto-approve threshold ${ui.dollars(autoApprove)}`,
    );
    ui.info(`  Auto-promoted to ready (under ${ui.dollars(autoApprove)} threshold)`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const planCommand: Command = {
  name: "plan",
  description: "Assign strategy and cost estimates to tasks",

  async run(args: string[]) {
    const db = getDb();

    // Check for help flag
    if (args.includes("-h") || args.includes("--help")) {
      console.log(this.help!());
      return;
    }

    const taskId = args[0];

    if (taskId) {
      // Plan a specific task
      planTask(db, taskId);
    } else {
      // Plan all ingested tasks
      ui.header("Planning Tasks");

      const ingested = db.tasksByStatus("ingested");

      if (ingested.length === 0) {
        ui.info("No ingested tasks to plan.");
        return;
      }

      let count = 0;
      for (const task of ingested) {
        if (planTask(db, task.id)) {
          count++;
        }
      }

      console.log();
      ui.success(`Planned ${count} task(s).`);
    }
  },

  help() {
    return [
      "Usage: grove plan [TASK_ID]",
      "",
      "Assign strategy and cost estimates to tasks.",
      "",
      "With a TASK_ID, plans that specific task.",
      'With no arguments, plans all "ingested" tasks.',
      "",
      "Strategy detection (keyword heuristics):",
      "  solo     -- Default for single-focus tasks",
      "  team     -- refactor, redesign, overhaul, migration",
      "  sweep    -- audit, validate, review all, scan",
      "  pipeline -- cross-repo, end-to-end",
      "",
      "After planning, tasks with estimated cost under the",
      'auto_approve_under budget threshold are auto-promoted to "ready".',
      "",
      "Examples:",
      "  grove plan W-001      Plan a specific task",
      "  grove plan            Plan all ingested tasks",
    ].join("\n");
  },
};
