// grove work / grove run — Core dispatch engine
// Selects a task, creates a worktree, spawns a Claude worker session.
import { getDb } from "../core/db";
import { budgetGet, settingsGet } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { dispatchTask, ANSI, renderBatchStatus, TERMINAL_STATUSES } from "../lib/dispatch";
import type { Command, Task } from "../types";

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export const workCommand: Command = {
  name: "work",
  description: "Dispatch a Claude Code worker session for a task",

  async run(args: string[]) {
    const db = getDb();
    let taskId = "";
    let repoFilter = "";
    let isRun = false;
    let batchSize = 0;

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--repo") {
        repoFilter = args[++i] || "";
        if (!repoFilter) ui.die("Usage: grove work --repo NAME");
      } else if (arg.startsWith("--repo=")) {
        repoFilter = arg.slice("--repo=".length);
      } else if (arg === "--run") {
        isRun = true;
      } else if (arg === "--batch") {
        const val = args[++i] || "";
        batchSize = parseInt(val, 10);
        if (isNaN(batchSize) || batchSize < 1) {
          ui.die("--batch requires a positive integer (e.g., --batch 5)");
        }
      } else if (arg.startsWith("--batch=")) {
        batchSize = parseInt(arg.slice("--batch=".length), 10);
        if (isNaN(batchSize) || batchSize < 1) {
          ui.die("--batch requires a positive integer (e.g., --batch 5)");
        }
      } else if (arg === "-h" || arg === "--help") {
        console.log(workCommand.help?.() ?? "");
        return;
      } else if (arg.startsWith("-")) {
        ui.die(`Unknown option: ${arg}`);
      } else {
        taskId = arg;
      }
      i++;
    }

    if (batchSize > 0 && taskId) {
      ui.die("--batch cannot be used with a specific task ID.");
    }
    if (batchSize > 0 && repoFilter) {
      ui.die("--batch cannot be used with --repo.");
    }
    if (batchSize > 0 && isRun) {
      ui.die("--batch cannot be used with --run.");
    }

    // --- Mode 0: Batch dispatch ---
    if (batchSize > 0) {
      const maxConcurrent = settingsGet("max_concurrent") || 4;
      const weekCost = db.costWeek();
      const weekBudget = budgetGet("per_week");

      // Select top N from queue (fetch extra to account for blocked tasks)
      const allCandidates = db.all<Task>(
        "SELECT * FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
        [batchSize * 2],
      );

      // Filter out blocked tasks
      const blockedIds: string[] = [];
      const candidates = allCandidates.filter((t) => {
        if (db.isTaskBlocked(t.id)) {
          blockedIds.push(t.id);
          return false;
        }
        return true;
      });

      if (blockedIds.length > 0) {
        for (const id of blockedIds) {
          const bt = db.taskGet(id);
          const deps = (bt?.depends_on ?? "").split(",").map((d) => d.trim()).filter(Boolean);
          const pending = deps.filter((dep) => {
            const dt = db.taskGet(dep);
            return !dt || (dt.status !== "done" && dt.status !== "completed");
          });
          ui.warn(`Skipping ${id}: blocked by ${pending.join(", ")}`);
        }
      }

      if (candidates.length === 0) {
        ui.info("No tasks ready to dispatch.");
        return;
      }

      // Cap by max_concurrent (accounting for already-running tasks)
      const runningCount = db.taskCount("running");
      const slotsAvailable = Math.max(0, maxConcurrent - runningCount);

      if (slotsAvailable === 0) {
        ui.die(`All ${maxConcurrent} concurrent slots in use. Wait or increase max_concurrent.`);
      }

      const toDispatch = candidates.slice(0, slotsAvailable);
      if (toDispatch.length < candidates.length) {
        ui.warn(`Capped to ${toDispatch.length} (${runningCount} already running, max ${maxConcurrent}).`);
      }

      // Budget warning
      if (weekBudget > 0) {
        const totalEstimated = toDispatch.reduce((sum, t) => sum + (t.estimated_cost ?? 0), 0);
        const remaining = weekBudget - weekCost;
        if (totalEstimated > remaining) {
          ui.warn(`Estimated cost $${totalEstimated.toFixed(2)} exceeds remaining budget $${remaining.toFixed(2)}.`);
        }
      }

      // Dispatch all in background
      ui.header(`Dispatching ${toDispatch.length} task(s)`);
      const dispatchedIds: string[] = [];

      for (const task of toDispatch) {
        const exitCode = await dispatchTask(task.id, false);
        if (exitCode === 0) {
          dispatchedIds.push(task.id);
        } else {
          ui.warn(`Failed to dispatch ${task.id}`);
        }
      }

      if (dispatchedIds.length === 0) {
        ui.error("No tasks were dispatched.");
        return;
      }

      console.log();

      // Live monitor loop
      const POLL_MS = 3_000;

      process.stdout.write(ANSI.hideCursor);

      const cleanup = () => process.stdout.write(ANSI.showCursor);
      const onSig = () => {
        cleanup();
        console.log(`\n  Detached. Workers continue in background.`);
        console.log(`  Use ${ui.bold("grove dashboard")} or ${ui.bold("grove watch TASK_ID")} to monitor.\n`);
        process.exit(0);
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);

      try {
        let isFirst = true;
        while (true) {
          renderBatchStatus(dispatchedIds, isFirst);
          isFirst = false;

          const allDone = dispatchedIds.every((id) => {
            const t = db.taskGet(id);
            return t && TERMINAL_STATUSES.has(t.status);
          });
          if (allDone) break;

          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        cleanup();
        process.removeListener("SIGINT", onSig);
        process.removeListener("SIGTERM", onSig);
      }

      // Final summary
      console.log();
      let batchDone = 0, batchFailed = 0, batchCost = 0;
      for (const id of dispatchedIds) {
        const t = db.taskGet(id);
        if (!t) continue;
        if (t.status === "failed") batchFailed++;
        else batchDone++;
        batchCost += t.cost_usd || 0;
      }

      if (batchFailed === 0) {
        ui.success(`Batch complete: ${batchDone} task(s) finished. Cost: ${ui.dollars(batchCost)}`);
      } else {
        ui.warn(`Batch complete: ${batchDone} succeeded, ${batchFailed} failed. Cost: ${ui.dollars(batchCost)}`);
      }
      return;
    }

    // --- Mode 1: Specific task ID ---
    if (taskId) {
      if (!db.taskExists(taskId)) {
        ui.die(`Task not found: ${taskId}`);
      }
      await dispatchTask(taskId, true);
      return;
    }

    // --- Mode 2: Next ready task for a repo ---
    if (repoFilter) {
      const next = db.get<{ id: string; title: string }>(
        "SELECT id, title FROM tasks WHERE repo = ? AND status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 1",
        [repoFilter]
      );
      if (!next) {
        ui.info(`No ready tasks for repo: ${repoFilter}`);
        return;
      }
      if (db.isTaskBlocked(next.id)) {
        ui.warn(`Skipping ${next.id}: blocked by dependencies`);
        return;
      }
      ui.info(`Next task for ${repoFilter}: ${next.id} — ${next.title}`);
      if (isRun || await prompts.confirm("Start this task?")) {
        await dispatchTask(next.id, true);
      }
      return;
    }

    // --- Mode 3: Batch selection (no args) ---
    const allReady = db.all<Task>(
      "SELECT id, repo, title, estimated_cost, depends_on FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 20"
    );

    const readyTasks = allReady.filter((t) => !db.isTaskBlocked(t.id));
    const blockedTasks = allReady.filter((t) => db.isTaskBlocked(t.id));

    if (readyTasks.length === 0 && blockedTasks.length === 0) {
      ui.info("No tasks ready to work on.");
      console.log(`  Run ${ui.bold("grove add")} to create a task, or ${ui.bold("grove sync")} to pull from GitHub.`);
      return;
    }

    if (readyTasks.length === 0) {
      ui.info("All ready tasks are blocked by dependencies.");
      for (const t of blockedTasks) {
        console.log(`  ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)} ${ui.dim(`blocked by ${t.depends_on}`)}`);
      }
      return;
    }

    // Non-interactive (run mode): pick the first task
    if (isRun) {
      await dispatchTask(readyTasks[0].id, false);
      return;
    }

    // Interactive: show tasks and let user pick
    ui.header("Ready Tasks");

    const maxConcurrent = settingsGet("max_concurrent") || 4;
    const weekCost = db.costWeek();
    const weekBudget = budgetGet("per_week");

    console.log(`  ${ui.dim("Budget:")} ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)} this week`);
    console.log(`  ${ui.dim("Max concurrent:")} ${maxConcurrent}`);
    console.log();

    // Display task list
    const taskIds: string[] = [];
    for (let idx = 0; idx < readyTasks.length; idx++) {
      const t = readyTasks[idx];
      const costStr = t.estimated_cost && t.estimated_cost > 0
        ? ` ~${ui.dollars(t.estimated_cost)}`
        : "";
      console.log(`  ${ui.bold(`[${idx + 1}]`)} ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)}${ui.dim(costStr)}`);
      taskIds.push(t.id);
    }

    if (blockedTasks.length > 0) {
      console.log();
      console.log(`  ${ui.dim("Blocked:")}`);
      for (const t of blockedTasks) {
        console.log(`    ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)} ${ui.dim(`waiting on ${t.depends_on}`)}`);
      }
    }

    console.log();
    console.log("  Enter task number(s) separated by spaces, or \"q\" to quit.");
    console.log("  Example: 1 3 5  (dispatches tasks 1, 3, and 5)");
    console.log();

    // Read selection via readline
    const rl = await import("node:readline");
    const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
    const selection = await new Promise<string>((resolve) => {
      iface.question("  Selection: ", (answer) => {
        iface.close();
        resolve(answer.trim());
      });
    });

    if (!selection || selection === "q" || selection === "Q") {
      return;
    }

    // Parse selections
    const selectedIds: string[] = [];
    for (const sel of selection.split(/\s+/)) {
      const num = parseInt(sel, 10);
      if (isNaN(num)) {
        ui.warn(`Ignoring non-numeric selection: ${sel}`);
        continue;
      }
      if (num < 1 || num > taskIds.length) {
        ui.warn(`Ignoring out-of-range selection: ${sel}`);
        continue;
      }
      selectedIds.push(taskIds[num - 1]);
    }

    if (selectedIds.length === 0) {
      ui.info("No tasks selected.");
      return;
    }

    // Confirm
    ui.info(`Selected ${selectedIds.length} task(s): ${selectedIds.join(" ")}`);
    const confirmed = await prompts.confirm("Dispatch these tasks?");
    if (!confirmed) return;

    console.log();

    // Dispatch
    if (selectedIds.length === 1) {
      await dispatchTask(selectedIds[0], true);
    } else {
      let dispatched = 0;
      for (let idx = 0; idx < selectedIds.length; idx++) {
        if (dispatched >= maxConcurrent) {
          ui.warn(`Reached max concurrent (${maxConcurrent}). Skipping remaining.`);
          break;
        }
        if (idx === 0) {
          ui.info(`Dispatching ${selectedIds[idx]} in foreground...`);
          await dispatchTask(selectedIds[idx], true).catch(() => {});
        } else {
          ui.info(`Dispatching ${selectedIds[idx]} in background...`);
          await dispatchTask(selectedIds[idx], false).catch(() => {});
        }
        dispatched++;
      }
    }
  },

  help() {
    return `Usage: grove work [TASK_ID] [--repo NAME] [--batch N]

Dispatch a Claude Code worker session for a task.

Modes:
  grove work TASK_ID       Start a specific task (foreground)
  grove work --repo NAME   Pick the next ready task for a repo
  grove work --batch N     Dispatch top N tasks in parallel
  grove work               Show ready tasks, choose interactively
  grove run TASK_ID        Non-interactive mode (auto-pick, no prompts)

What happens:
  1. Creates a git worktree for the task
  2. Deploys sandbox (guard hooks + CLAUDE.md overlay)
  3. Spawns "claude -p" with stream-json output
  4. Captures session summary, cost, and files modified
  5. Auto-publishes (push + draft PR) on success

Options:
  --repo NAME    Filter to tasks for a specific repo
  --batch N      Dispatch N tasks in parallel with live status monitor
  --run          Non-interactive mode (same as "grove run")

Dependencies:
  Tasks with --depends are skipped until all dependencies complete.
  Use "grove add --depends W-001,W-002" to set dependencies.
  Blocked tasks show a warning when skipped during dispatch.

Batch mode:
  Selects top N tasks from the priority queue. All run in background.
  Displays a live status table until all tasks finish.
  Capped by max_concurrent setting and weekly budget.
  Ctrl+C detaches — workers continue in background.

Interactive mode: select multiple tasks to dispatch. The first runs in
foreground; the rest run in background up to max_concurrent.`;
  },
};
