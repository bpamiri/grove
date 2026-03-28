// Grove v3 — Worker dispatch with concurrency control
// Manages the queue of tasks waiting to be dispatched, respects max_workers limit,
// handles dependency ordering, and integrates with budget checks.
import { bus } from "./event-bus";
import { activeWorkerCount } from "../agents/worker";
import { isSpawningPaused } from "../monitor/cost";
import type { Database } from "./db";
import type { Task, Tree } from "../shared/types";

interface DispatchOptions {
  db: Database;
  maxWorkers: number;
}

let opts: DispatchOptions | null = null;
const pendingQueue: string[] = []; // Task IDs waiting to be dispatched

/** Initialize the dispatch system */
export function initDispatch(options: DispatchOptions): void {
  opts = options;

  // Listen for task creation events to queue dispatch
  bus.on("task:created", ({ task }) => {
    if (task.status === "queued") {
      enqueue(task.id);
    }
  });

  // Listen for worker completion to dispatch next in queue
  bus.on("worker:ended", () => {
    processQueue();
  });

  // Listen for merge completion to check unblocked tasks
  bus.on("merge:completed", ({ taskId }) => {
    const unblocked = opts!.db.getNewlyUnblocked(taskId);
    for (const task of unblocked) {
      opts!.db.taskSetStatus(task.id, "queued");
      enqueue(task.id);
    }
  });
}

/** Add a task to the dispatch queue */
export function enqueue(taskId: string): void {
  if (!pendingQueue.includes(taskId)) {
    pendingQueue.push(taskId);
  }
  processQueue();
}

/** Process the queue — dispatch as many tasks as allowed */
function processQueue(): void {
  if (!opts) return;
  const { db, maxWorkers } = opts;

  while (pendingQueue.length > 0) {
    // Check worker limit
    if (activeWorkerCount() >= maxWorkers) {
      break;
    }

    // Check budget
    if (isSpawningPaused()) {
      db.addEvent(null, null, "budget_exceeded", "Worker dispatch paused — budget exceeded");
      break;
    }

    const taskId = pendingQueue[0];
    const task = db.taskGet(taskId);

    if (!task) {
      pendingQueue.shift();
      continue;
    }

    // Skip if task is no longer in a dispatchable state
    if (task.status !== "queued") {
      pendingQueue.shift();
      continue;
    }

    // Skip if blocked by dependencies
    if (db.isTaskBlocked(taskId)) {
      pendingQueue.shift();
      // Re-enqueue at the end — might become unblocked later
      pendingQueue.push(taskId);
      continue;
    }

    // Skip if no tree assigned
    if (!task.tree_id) {
      pendingQueue.shift();
      db.addEvent(taskId, null, "dispatch_failed", "No tree assigned to task");
      continue;
    }

    const tree = db.treeGet(task.tree_id);
    if (!tree) {
      pendingQueue.shift();
      db.addEvent(taskId, null, "dispatch_failed", `Tree '${task.tree_id}' not found`);
      continue;
    }

    // Dispatch!
    pendingQueue.shift();
    try {
      const { startPipeline } = require("../engine/step-engine");
      startPipeline(task, tree, db);
    } catch (err: any) {
      db.addEvent(taskId, null, "dispatch_failed", `Spawn failed: ${err.message}`);
      db.taskSetStatus(taskId, "failed");
    }
  }
}

/** Get the current queue length */
export function queueLength(): number {
  return pendingQueue.length;
}

/** Get the queue contents (for status display) */
export function getQueue(): string[] {
  return [...pendingQueue];
}
