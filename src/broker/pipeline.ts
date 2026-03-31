// Grove v3 — Pipeline wiring: connects event bus events to trigger the full lifecycle
// worker:ended → evaluator → merge manager → orchestrator notification
import { bus } from "./event-bus";
import { evaluate } from "../agents/evaluator";
import { queueMerge } from "../merge/manager";
import * as orchestrator from "../agents/orchestrator";
import type { Database } from "./db";

/**
 * Wire up the full task pipeline:
 * 1. Worker completes (done) → spawn evaluator
 * 2. Evaluator passes → queue merge
 * 3. Evaluator fails → notify orchestrator (retry or escalate)
 * 4. CI fails → notify orchestrator
 * 5. Merge completes → check for newly unblocked tasks
 */
export function wirePipeline(db: Database): void {
  // Worker done → evaluate
  bus.on("worker:ended", async ({ taskId, status }) => {
    if (status !== "done") return; // Only evaluate successful completions

    const task = db.taskGet(taskId);
    if (!task || !task.tree_id) return;

    // Skip if task has already moved past "done" (e.g., already evaluated or failed)
    if (task.status !== "done") return;

    const tree = db.treeGet(task.tree_id);
    if (!tree) return;

    // Run evaluation (may include async plugin hooks)
    const result = await evaluate(task, tree, db);

    if (result.passed) {
      // Queue for merge
      queueMerge(db.taskGet(taskId)!, tree, db);
    } else {
      // Check retry count
      const currentTask = db.taskGet(taskId)!;
      if (currentTask.retry_count < currentTask.max_retries) {
        // Auto-retry: increment count, notify orchestrator
        db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
        db.addEvent(taskId, null, "auto_retried", `Retrying (${currentTask.retry_count + 1}/${currentTask.max_retries})`);

        // Notify orchestrator to re-dispatch with failure context
        orchestrator.sendMessage(
          `Task ${taskId} failed evaluation. Gate failures:\n${result.feedback}\n\nRetrying (${currentTask.retry_count + 1}/${currentTask.max_retries}). Please re-dispatch the worker with the failure context.`
        );
      } else {
        // Exhausted retries — escalate to user
        db.taskSetStatus(taskId, "failed");
        db.addEvent(taskId, null, "retry_exhausted", `Retries exhausted (${currentTask.max_retries})`);
        orchestrator.sendMessage(
          `Task ${taskId} failed evaluation after ${currentTask.max_retries} retries. Gate failures:\n${result.feedback}\n\nPlease review and decide how to proceed.`
        );
      }
    }
  });

  // CI failed → notify orchestrator
  bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
    orchestrator.sendMessage(
      `CI failed on PR #${prNumber} for task ${taskId}. Please review the CI logs and decide: retry the worker, or escalate to the user.`
    );
  });

  // Rebase failed (unresolvable conflict) → notify orchestrator
  bus.on("merge:rebase_failed", ({ taskId, prNumber }) => {
    orchestrator.sendMessage(
      `Merge conflict on PR #${prNumber} for task ${taskId} could not be auto-resolved via rebase. Please resolve conflicts manually and re-queue the merge.`
    );
  });

  // Conflict detected pre-merge (drift during CI) → notify orchestrator
  bus.on("merge:conflict_detected", ({ taskId, prNumber }) => {
    orchestrator.sendMessage(
      `Merge conflict detected on PR #${prNumber} for task ${taskId} after CI passed. The base branch changed during CI. Please rebase and retry.`
    );
  });

  // Merge completed → check for newly unblocked tasks
  bus.on("merge:completed", ({ taskId }) => {
    const unblocked = db.getNewlyUnblocked(taskId);
    if (unblocked.length > 0) {
      const taskList = unblocked.map(t => `${t.id}: ${t.title}`).join(", ");
      orchestrator.sendMessage(
        `Task ${taskId} merged. ${unblocked.length} task(s) are now unblocked: ${taskList}. You can dispatch workers for them.`
      );
    }
  });
}
