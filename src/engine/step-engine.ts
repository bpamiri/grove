// Grove v3 — Step Engine: configurable pipeline that replaces hardcoded event wiring.
// Reads path config to determine step transitions, supports branching and retries.
import { bus } from "../broker/event-bus";
import { configNormalizedPaths } from "../broker/config";
import type { Database } from "../broker/db";
import type { Task, Tree, PipelineStep, NormalizedPathConfig } from "../shared/types";
import type { PluginHost } from "../plugins/host";

// Module-level DB reference so onStepComplete can access it without threading db through events.
let _db: Database | null = null;

// Module-level plugin host reference — set during wireStepEngine, avoids circular dynamic imports.
let _pluginHost: PluginHost | null = null;

/** Test-only: set _db without side effects (no bus handlers, no async imports). */
export function _setDb(db: Database): void { _db = db; }

/** Set the plugin host reference (called from broker after PluginHost is initialized). */
export function setPluginHost(host: PluginHost | null): void { _pluginHost = host; }

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
 * Resume a task's pipeline at its current step or an explicit step.
 * Used after manual conflict resolution or re-enqueue at a specific step.
 * Returns { ok, error? } so callers can surface validation failures.
 */
export function resumePipeline(
  task: Task,
  tree: Tree,
  db: Database,
  stepId?: string,
): { ok: boolean; error?: string } {
  _db = db;

  // Validate current_step exists (not null, not terminal)
  const targetStepId = stepId ?? task.current_step;
  if (!targetStepId) {
    return { ok: false, error: "Cannot resume task with no current step" };
  }
  if (targetStepId === "$done" || targetStepId === "$fail") {
    return { ok: false, error: `Cannot resume task at terminal state "${targetStepId}"` };
  }

  const paths = configNormalizedPaths();
  const pathConfig = paths[task.path_name];
  if (!pathConfig || !pathConfig.steps.length) {
    return { ok: false, error: `Path config "${task.path_name}" not found or has no steps` };
  }

  const step = pathConfig.steps.find((s) => s.id === targetStepId);
  if (!step) {
    return { ok: false, error: `Step "${targetStepId}" not found in path "${task.path_name}"` };
  }

  const stepIndex = pathConfig.steps.indexOf(step);

  // Reset retry count and set step/status
  db.run(
    "UPDATE tasks SET status = 'active', current_step = ?, step_index = ?, retry_count = 0 WHERE id = ?",
    [step.id, stepIndex, task.id],
  );
  db.addEvent(task.id, null, "step_resumed", `Resumed at step "${step.id}" (index ${stepIndex})`);
  bus.emit("task:status", { taskId: task.id, status: "active" });

  const updated = db.taskGet(task.id);
  if (!updated) return { ok: false, error: "Task disappeared after update" };

  executeStep(updated, step, tree, db);
  return { ok: true };
}

/**
 * Called when the current step finishes. Resolves the next transition target
 * ($done, $fail, or another step-id) and advances the pipeline.
 */
export function onStepComplete(
  taskId: string,
  outcome: "success" | "failure" | "fatal",
  context?: string,
): void {
  const db = _db;
  if (!db) return;

  const task = db.taskGet(taskId);
  if (!task) return;

  // Fatal failure — immediate task failure, no retry or transition (W-030)
  if (outcome === "fatal") {
    failTask(db, taskId, context ?? "Fatal failure — manual intervention required");
    return;
  }

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

  // Fire-and-forget step:post plugin hook
  if (_pluginHost) {
    _pluginHost.runHook("step:post", {
      taskId,
      stepId: currentStep.id,
      outcome,
      context,
    }).catch(() => {});
  }

  // --- $done ---
  if (target === "$done") {
    db.run(
      "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    bus.emit("task:status", { taskId, status: "completed" });
    bus.emit("merge:completed", { taskId, prNumber: task.pr_number ?? 0 });

    // Best-effort worktree cleanup (non-merge path only — merge uses postMergeCleanup)
    if (task.tree_id && !task.pr_number) {
      const tree = db.treeGet(task.tree_id);
      if (tree) {
        import("../shared/worktree").then(({ cleanupWorktree }) => {
          cleanupWorktree(taskId, tree.path);
        }).catch(() => {});
      }
    }
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

    // Best-effort worktree cleanup
    if (task.tree_id) {
      const tree = db.treeGet(task.tree_id);
      if (tree) {
        import("../shared/worktree").then(({ cleanupWorktree }) => {
          cleanupWorktree(taskId, tree.path);
        }).catch(() => {});
      }
    }
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

/** Look up the current PipelineStep config for a task (used by worker for result_file). */
export function getStepForTask(taskId: string): PipelineStep | null {
  if (!_db) return null;
  const task = _db.taskGet(taskId);
  if (!task?.current_step) return null;

  const paths = configNormalizedPaths();
  const pathConfig = paths[task.path_name];
  if (!pathConfig) return null;

  return pathConfig.steps.find(s => s.id === task.current_step) ?? null;
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
 * Dispatch execution based on step type (worker, verdict).
 * Uses dynamic imports to avoid circular dependencies.
 */
async function executeStep(
  task: Task,
  step: PipelineStep,
  tree: Tree,
  db: Database,
): Promise<void> {
  db.addEvent(task.id, null, "step_entered", `Entered step "${step.id}" (${step.type})`);

  // Run step:pre plugin hook — if any handler returns proceed=false, skip the step
  if (_pluginHost) {
    try {
      const preResults = await _pluginHost.runHook("step:pre", {
        taskId: task.id,
        stepId: step.id,
        stepType: step.type,
        treeId: tree.id,
      });
      const blocked = preResults.find((r: any) => r.proceed === false);
      if (blocked) {
        db.addEvent(task.id, null, "step_skipped", `Plugin blocked step "${step.id}": ${blocked.reason ?? "no reason"}`);
        onStepComplete(task.id, "failure", `Plugin blocked: ${blocked.reason ?? "no reason"}`);
        return;
      }
    } catch (err) {
      // Plugin errors must never crash step execution
      console.error("[plugins] step:pre hook error:", err);
    }
  }

  switch (step.type) {
    case "worker": {
      const { spawnWorker } = await import("../agents/worker");
      const { getEnv } = await import("../broker/db");
      const logDir = getEnv().GROVE_LOG_DIR;
      spawnWorker(task, tree, db, logDir, step);
      break;
    }

    case "verdict": {
      db.run(
        "UPDATE tasks SET status = 'waiting', paused = 1 WHERE id = ?",
        [task.id],
      );
      db.addEvent(task.id, null, "verdict_waiting", "Awaiting maintainer decision");
      bus.emit("task:status", { taskId: task.id, status: "waiting" });
      // Pipeline pauses here — no onStepComplete. Human acts via /api/tasks/:id/verdict
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

  // Best-effort worktree cleanup
  const task = db.taskGet(taskId);
  if (task?.tree_id) {
    const tree = db.treeGet(task.tree_id);
    if (tree) {
      import("../shared/worktree").then(({ cleanupWorktree }) => {
        cleanupWorktree(taskId, tree.path);
      }).catch(() => {});
    }
  }
}
