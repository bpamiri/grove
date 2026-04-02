// Grove v3 — Orchestrator event feedback loop
// Subscribes to pipeline lifecycle events and injects concise, actionable status
// messages into the orchestrator's message queue so it can react to outcomes.
// Gated by `settings.proactive` in grove.yaml (default: true).
import { bus } from "./event-bus";
import { settingsGet } from "./config";
import * as orchestrator from "../agents/orchestrator";
import type { Database } from "./db";

let _db: Database | null = null;
const _unsubs: Array<() => void> = [];

/** Check whether feedback is enabled (settings.proactive). */
function isProactive(): boolean {
  return settingsGet("proactive") !== false;
}

/** Look up a task title for context-rich messages. Returns "taskId" if not found. */
function taskLabel(taskId: string): string {
  if (!_db) return taskId;
  const task = _db.taskGet(taskId);
  if (!task) return taskId;
  return `${task.id} ("${task.title}")`;
}

/**
 * Wire the orchestrator feedback loop into the event bus.
 * Call once during broker startup, after orchestrator.init().
 */
export function wireOrchestratorFeedback(db: Database): void {
  _db = db;

  // -- Worker lifecycle -------------------------------------------------------

  _unsubs.push(
    bus.on("worker:ended", ({ taskId, status }) => {
      if (!isProactive()) return;
      // "done" status is handled by the step engine (eval/merge pipeline).
      // Only notify for unexpected failures.
      if (status === "done") return;

      orchestrator.sendMessage(
        `[event] Worker for ${taskLabel(taskId)} exited with status "${status}". ` +
        `The step engine will handle retries if configured. Review if this is unexpected.`,
      );
    }),
  );

  // -- Evaluation outcomes ----------------------------------------------------

  _unsubs.push(
    bus.on("eval:passed", ({ taskId, feedback }) => {
      if (!isProactive()) return;
      const extra = feedback ? ` Feedback: ${feedback}` : "";
      orchestrator.sendMessage(
        `[event] ${taskLabel(taskId)} passed evaluation — queued for merge.${extra}`,
      );
    }),
  );

  _unsubs.push(
    bus.on("eval:failed", ({ taskId, feedback }) => {
      if (!isProactive()) return;
      const task = _db?.taskGet(taskId);
      const retryInfo = task
        ? ` (retry ${task.retry_count}/${task.max_retries})`
        : "";
      orchestrator.sendMessage(
        `[event] ${taskLabel(taskId)} failed evaluation${retryInfo}. ` +
        `Failures: ${feedback}. Step engine will auto-retry if retries remain.`,
      );
    }),
  );

  // -- Review outcomes --------------------------------------------------------

  _unsubs.push(
    bus.on("review:rejected", ({ taskId, feedback }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[event] ${taskLabel(taskId)} review rejected. Feedback: ${feedback}. ` +
        `Should I restructure the approach or address the feedback directly?`,
      );
    }),
  );

  _unsubs.push(
    bus.on("review:approved", ({ taskId }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[event] ${taskLabel(taskId)} review approved — proceeding to next step.`,
      );
    }),
  );

  // -- Merge outcomes ---------------------------------------------------------

  _unsubs.push(
    bus.on("merge:pr_created", ({ taskId, prNumber, prUrl }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[event] PR #${prNumber} created for ${taskLabel(taskId)}. URL: ${prUrl}`,
      );
    }),
  );

  _unsubs.push(
    bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[event] CI failed on PR #${prNumber} for ${taskLabel(taskId)}. ` +
        `Review the CI logs and decide: retry the worker, or escalate to the user.`,
      );
    }),
  );

  _unsubs.push(
    bus.on("merge:completed", ({ taskId, prNumber }) => {
      if (!isProactive()) return;
      const unblocked = db.getNewlyUnblocked(taskId);
      const unblockedInfo = unblocked.length > 0
        ? ` ${unblocked.length} task(s) now unblocked: ${unblocked.map(t => t.id).join(", ")}.`
        : "";
      orchestrator.sendMessage(
        `[event] ${taskLabel(taskId)} merged (PR #${prNumber}).${unblockedInfo}` +
        ` Plan next steps if needed.`,
      );
    }),
  );

  // -- Task terminal states ---------------------------------------------------

  _unsubs.push(
    bus.on("task:status", ({ taskId, status }) => {
      if (!isProactive()) return;
      if (status === "failed") {
        const task = _db?.taskGet(taskId);
        const stepInfo = task?.current_step ? ` at step "${task.current_step}"` : "";
        const retryInfo = task ? ` after ${task.retry_count} retries` : "";
        orchestrator.sendMessage(
          `[event] ${taskLabel(taskId)} failed${stepInfo}${retryInfo}. ` +
          `Retries exhausted — please review and decide how to proceed.`,
        );
      }
    }),
  );

  // -- Budget alerts ----------------------------------------------------------

  _unsubs.push(
    bus.on("cost:budget_warning", ({ current, limit, period }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[budget] Warning: $${current.toFixed(2)}/$${limit.toFixed(2)} spent this ${period}. ` +
        `Consider pausing non-critical tasks.`,
      );
    }),
  );

  _unsubs.push(
    bus.on("cost:budget_exceeded", ({ current, limit, period }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[budget] EXCEEDED: $${current.toFixed(2)}/$${limit.toFixed(2)} this ${period}. ` +
        `Worker spawning is paused. Waiting for user decision.`,
      );
    }),
  );

  // -- Health monitor alerts --------------------------------------------------

  _unsubs.push(
    bus.on("monitor:stall", ({ taskId, inactiveMinutes }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[health] ${taskLabel(taskId)} worker stalled — no activity for ${inactiveMinutes} minutes. ` +
        `Should I restart it?`,
      );
    }),
  );

  _unsubs.push(
    bus.on("monitor:crash", ({ taskId }) => {
      if (!isProactive()) return;
      orchestrator.sendMessage(
        `[health] ${taskLabel(taskId)} worker crashed. ` +
        `The step engine may auto-retry. Investigate if this recurs.`,
      );
    }),
  );
}

/** Tear down all subscriptions (for tests or shutdown). */
export function unwireOrchestratorFeedback(): void {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
  _db = null;
}
