// Grove v3 — Step Engine: configurable pipeline that replaces hardcoded event wiring.
// Reads path config to determine step transitions, supports branching and retries.
import { bus } from "../broker/event-bus";
import { configNormalizedPaths } from "../broker/config";
import type { Database } from "../broker/db";
import type { Task, Tree, PipelineStep, NormalizedPathConfig } from "../shared/types";

// Module-level DB reference so onStepComplete can access it without threading db through events.
let _db: Database | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a task's pipeline: resolve path config, set first step, begin execution.
 */
export function startPipeline(task: Task, tree: Tree, db: Database): void {
  _db = db;

  const paths = configNormalizedPaths();
  const pathConfig = paths[task.path_name];

  if (!pathConfig || !pathConfig.steps.length) {
    db.taskSetStatus(task.id, "failed");
    db.addEvent(task.id, null, "task_failed", `No path config found for "${task.path_name}" or path has no steps`);
    bus.emit("task:status", { taskId: task.id, status: "failed" });
    return;
  }

  const firstStep = pathConfig.steps[0];

  // If task has a seed and first step is a "plan" worker, skip to next step
  const seed = db.seedGet(task.id);
  let startStep = firstStep;
  let startIndex = 0;

  if (seed?.spec && firstStep.type === "worker" && firstStep.id === "plan" && pathConfig.steps.length > 1) {
    startStep = pathConfig.steps[1];
    startIndex = 1;
    db.addEvent(task.id, null, "step_skipped", `Skipped "${firstStep.id}" — seed spec provides the plan`);
  }

  db.run(
    "UPDATE tasks SET status = 'active', current_step = ?, step_index = ? WHERE id = ?",
    [startStep.id, startIndex, task.id],
  );
  bus.emit("task:status", { taskId: task.id, status: "active" });

  // Re-read task to get updated fields
  const updated = db.taskGet(task.id);
  if (!updated) return;

  executeStep(updated, startStep, tree, db);
}

/**
 * Called when the current step finishes. Resolves the next transition target
 * ($done, $fail, or another step-id) and advances the pipeline.
 */
export function onStepComplete(
  taskId: string,
  outcome: "success" | "failure",
  context?: string,
): void {
  const db = _db;
  if (!db) return;

  const task = db.taskGet(taskId);
  if (!task) return;

  const paths = configNormalizedPaths();
  const pathConfig = paths[task.path_name];
  if (!pathConfig) {
    failTask(db, taskId, "Path config not found during step completion");
    return;
  }

  const currentStep = pathConfig.steps.find((s) => s.id === task.current_step);
  if (!currentStep) {
    failTask(db, taskId, `Current step "${task.current_step}" not found in path config`);
    return;
  }

  const target = outcome === "success" ? currentStep.on_success : currentStep.on_failure;

  // --- $done ---
  if (target === "$done") {
    db.run(
      "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    bus.emit("task:status", { taskId, status: "completed" });
    bus.emit("merge:completed", { taskId, prNumber: task.pr_number ?? 0 });
    return;
  }

  // --- $fail ---
  if (target === "$fail") {
    const maxRetries = currentStep.max_retries ?? task.max_retries;
    if (task.retry_count < maxRetries) {
      // Retry: increment count, re-enter same step
      db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
      db.addEvent(
        taskId,
        null,
        "auto_retried",
        `Retrying step "${currentStep.id}" (${task.retry_count + 1}/${maxRetries})${context ? `: ${context}` : ""}`,
      );

      const retask = db.taskGet(taskId);
      if (!retask || !retask.tree_id) return;
      const tree = db.treeGet(retask.tree_id);
      if (!tree) return;

      executeStep(retask, currentStep, tree, db);
      return;
    }

    // Retries exhausted
    db.run(
      "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
      [taskId],
    );
    db.addEvent(
      taskId,
      null,
      "retry_exhausted",
      `Retries exhausted (${task.max_retries})${context ? `: ${context}` : ""}`,
    );
    bus.emit("task:status", { taskId, status: "failed" });
    return;
  }

  // --- step-id transition ---
  const nextStep = pathConfig.steps.find((s) => s.id === target);
  if (!nextStep) {
    failTask(db, taskId, `Invalid transition target "${target}" from step "${currentStep.id}"`);
    return;
  }

  const nextIndex = pathConfig.steps.indexOf(nextStep);
  db.run(
    "UPDATE tasks SET current_step = ?, step_index = ? WHERE id = ?",
    [nextStep.id, nextIndex, taskId],
  );

  const retask = db.taskGet(taskId);
  if (!retask || !retask.tree_id) return;
  const tree = db.treeGet(retask.tree_id);
  if (!tree) return;

  executeStep(retask, nextStep, tree, db);
}

/**
 * Wire the step engine into the event bus. Replaces wirePipeline.
 * Listens for merge:completed to unblock dependent tasks.
 */
export function wireStepEngine(db: Database): void {
  _db = db;

  bus.on("merge:completed", ({ taskId }) => {
    const unblocked = db.getNewlyUnblocked(taskId);
    for (const task of unblocked) {
      db.taskSetStatus(task.id, "queued");
      // Dynamically import dispatch to avoid circular deps
      import("../broker/dispatch").then(({ enqueue }) => {
        enqueue(task.id);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Dispatch execution based on step type (worker, gate, merge).
 * Uses dynamic imports to avoid circular dependencies.
 */
async function executeStep(
  task: Task,
  step: PipelineStep,
  tree: Tree,
  db: Database,
): Promise<void> {
  db.addEvent(task.id, null, "step_entered", `Entered step "${step.id}" (${step.type})`);

  switch (step.type) {
    case "worker": {
      const { spawnWorker } = await import("../agents/worker");
      const { getEnv } = await import("../broker/db");
      const logDir = getEnv().GROVE_LOG_DIR;
      spawnWorker(task, tree, db, logDir, step.prompt);
      break;
    }

    case "gate": {
      const { evaluate } = await import("../agents/evaluator");
      const result = evaluate(task, tree, db);
      onStepComplete(task.id, result.passed ? "success" : "failure", result.feedback);
      break;
    }

    case "merge": {
      const { queueMerge } = await import("../merge/manager");
      queueMerge(task, tree, db);
      break;
    }

    default:
      failTask(db, task.id, `Unknown step type "${(step as any).type}"`);
  }
}

/** Helper to mark a task as failed with an event. */
function failTask(db: Database, taskId: string, reason: string): void {
  db.run(
    "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
    [taskId],
  );
  db.addEvent(taskId, null, "task_failed", reason);
  bus.emit("task:status", { taskId, status: "failed" });
}
