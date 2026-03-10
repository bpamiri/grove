// grove drain — Continuous queue drainer with N concurrent workers
import { getDb } from "../core/db";
import { budgetGet, settingsGet } from "../core/config";
import * as ui from "../core/ui";
import { dispatchTask, ANSI, renderBatchStatus } from "../lib/dispatch";
import type { Command, Task } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 3_000;
const TERMINAL = new Set(["done", "completed", "failed", "review"]);

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const drainCommand: Command = {
  name: "drain",
  description: "Continuously dispatch tasks until the queue is empty",

  async run(args: string[]) {
    const db = getDb();
    let slotsOverride = 0;
    let dryRun = false;

    // -- Argument parsing --
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "-n") {
        const val = args[++i] || "";
        slotsOverride = parseInt(val, 10);
        if (isNaN(slotsOverride) || slotsOverride < 1) {
          ui.die("-n requires a positive integer (e.g., -n 3)");
        }
      } else if (arg.startsWith("-n=")) {
        slotsOverride = parseInt(arg.slice(3), 10);
        if (isNaN(slotsOverride) || slotsOverride < 1) {
          ui.die("-n requires a positive integer (e.g., -n=3)");
        }
      } else if (/^-n\d+$/.test(arg)) {
        slotsOverride = parseInt(arg.slice(2), 10);
        if (isNaN(slotsOverride) || slotsOverride < 1) {
          ui.die("-n requires a positive integer (e.g., -n3)");
        }
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(drainCommand.help?.() ?? "");
        return;
      } else {
        ui.die(`Unknown option: ${arg}`);
      }
      i++;
    }

    const maxSlots = slotsOverride || settingsGet("max_concurrent") || 4;

    // -- Build initial queue --
    const allCandidates = db.all<Task>(
      "SELECT * FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC"
    );

    const queue: string[] = [];
    const blockedIds: string[] = [];

    for (const t of allCandidates) {
      if (db.isTaskBlocked(t.id)) {
        blockedIds.push(t.id);
      } else {
        queue.push(t.id);
      }
    }

    if (queue.length === 0 && blockedIds.length === 0) {
      ui.info("No tasks ready to drain.");
      return;
    }

    if (blockedIds.length > 0) {
      ui.info(`${blockedIds.length} blocked task(s) will auto-enqueue when dependencies complete.`);
    }

    // -- Dry run --
    if (dryRun) {
      const weekCost = db.costWeek();
      const weekBudget = budgetGet("per_week");

      ui.header("Drain — Dry Run");
      console.log(`  ${ui.dim("Concurrency:")} ${maxSlots}`);
      console.log(`  ${ui.dim("Queue:")}       ${queue.length} task(s)`);
      console.log(`  ${ui.dim("Blocked:")}     ${blockedIds.length} task(s)`);
      console.log(`  ${ui.dim("Budget:")}      ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)} this week`);
      console.log();

      let totalEstimated = 0;

      for (const id of queue) {
        const t = db.taskGet(id);
        if (!t) continue;
        const cost = t.estimated_cost ?? 0;
        totalEstimated += cost;
        const costStr = cost > 0 ? ui.dim(` ~${ui.dollars(cost)}`) : "";
        console.log(`  ${ui.statusBadge(t.status)} ${ui.bold(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)}${costStr}`);
      }

      for (const id of blockedIds) {
        const t = db.taskGet(id);
        if (!t) continue;
        const deps = (t.depends_on ?? "").split(",").map((d) => d.trim()).filter(Boolean);
        const pending = deps.filter((dep) => {
          const dt = db.taskGet(dep);
          return !dt || (dt.status !== "done" && dt.status !== "completed");
        });
        console.log(`  ${ui.badge("blocked", "yellow")} ${ui.bold(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)} ${ui.dim(`waiting on ${pending.join(", ")}`)}`);
      }

      console.log();
      console.log(`  ${ui.dim("Estimated total:")} ${ui.dollars(totalEstimated)}`);
      console.log();
      return;
    }

    // -- Main dispatch loop --
    const activeIds: string[] = [];
    const allDispatchedIds: string[] = [];
    const stats = { totalDone: 0, totalFailed: 0, autoEnqueued: 0, startTime: Date.now() };
    let isFirstRender = true;

    // Ctrl+C handler — detach cleanly
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
      while (true) {
        // Fill slots
        while (activeIds.length < maxSlots && queue.length > 0) {
          const nextId = queue.shift()!;

          // Budget check
          const weekCost = db.costWeek();
          const weekBudget = budgetGet("per_week");
          const task = db.taskGet(nextId);
          const estCost = task?.estimated_cost ?? 0;

          if (weekBudget > 0 && weekCost + estCost > weekBudget) {
            ui.warn(`Budget exceeded — skipping ${nextId} (${ui.dollars(weekCost)} + ~${ui.dollars(estCost)} > ${ui.dollars(weekBudget)})`);
            continue;
          }

          const exitCode = await dispatchTask(nextId, false);
          if (exitCode === 0) {
            activeIds.push(nextId);
            allDispatchedIds.push(nextId);
          } else {
            ui.warn(`Failed to dispatch ${nextId}`);
          }
        }

        // Terminate check
        if (activeIds.length === 0 && queue.length === 0) break;

        // Render status
        if (allDispatchedIds.length > 0) {
          renderBatchStatus(allDispatchedIds, isFirstRender);
          isFirstRender = false;
        }

        // Poll wait
        await new Promise((r) => setTimeout(r, POLL_MS));

        // Check active workers
        const stillActive: string[] = [];
        for (const id of activeIds) {
          const task = db.taskGet(id);
          if (task && TERMINAL.has(task.status)) {
            if (task.status === "failed") {
              stats.totalFailed++;
            } else {
              stats.totalDone++;
            }

            // Check for newly unblocked tasks
            if (task.status === "done" || task.status === "completed") {
              const unblocked = db.getNewlyUnblocked(id);
              for (const ut of unblocked) {
                const alreadyTracked =
                  queue.includes(ut.id) ||
                  activeIds.includes(ut.id) ||
                  allDispatchedIds.includes(ut.id);
                if (!alreadyTracked) {
                  queue.push(ut.id);
                  stats.autoEnqueued++;
                  ui.info(`Auto-enqueued: ${ut.id} (${ut.title})`);
                }
              }
            }
          } else {
            stillActive.push(id);
          }
        }

        activeIds.length = 0;
        activeIds.push(...stillActive);

        // Budget exhaustion check
        if (queue.length > 0) {
          const weekBudget = budgetGet("per_week");
          if (weekBudget > 0) {
            const weekCost = db.costWeek();
            const allExceed = queue.every((id) => {
              const t = db.taskGet(id);
              return weekCost + (t?.estimated_cost ?? 0) > weekBudget;
            });
            if (allExceed && activeIds.length === 0) {
              ui.warn(`Budget exhausted. ${queue.length} task(s) remain but all exceed budget.`);
              break;
            }
          }
        }
      }
    } finally {
      cleanup();
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }

    // -- Final summary --
    const elapsed = Math.floor((Date.now() - stats.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    console.log();

    let totalCost = 0;
    for (const id of allDispatchedIds) {
      const t = db.taskGet(id);
      totalCost += t?.cost_usd ?? 0;
    }

    ui.header("Drain Complete");
    console.log(`  ${ui.dim("Elapsed:")}      ${minutes}:${String(seconds).padStart(2, "0")}`);
    console.log(`  ${ui.dim("Done:")}         ${stats.totalDone}`);
    console.log(`  ${ui.dim("Failed:")}       ${stats.totalFailed}`);
    console.log(`  ${ui.dim("Total cost:")}   ${ui.dollars(totalCost)}`);
    if (stats.autoEnqueued > 0) {
      console.log(`  ${ui.dim("Auto-enqueued:")} ${stats.autoEnqueued}`);
    }
    console.log();
  },

  help() {
    return `Usage: grove drain [-n SLOTS] [--dry-run]

Continuously dispatch tasks until the queue is empty.

Maintains up to N concurrent workers. When a worker finishes, the
next ready task is dispatched immediately. Tasks unblocked by completed
dependencies are automatically added to the queue.

Options:
  -n SLOTS     Max concurrent workers (default: max_concurrent setting)
  --dry-run    Show what would be dispatched without starting workers

Behavior:
  - Dispatches ready/planned tasks in priority order
  - Skips blocked tasks (auto-enqueues when dependencies complete)
  - Stops dispatching when weekly budget would be exceeded
  - Ctrl+C detaches — workers continue in background

Examples:
  grove drain              Drain queue with default concurrency
  grove drain -n 2         Conservative: max 2 concurrent workers
  grove drain --dry-run    Preview what would be dispatched`;
  },
};
