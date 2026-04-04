// Grove v3 — Orchestrator event feedback loop
// Subscribes to pipeline lifecycle events and sends concise, actionable status
// messages to the orchestrator via sendMessage() so it can react to outcomes.
// Gated by `settings.proactive` in grove.yaml (default: true).
import { bus } from "./event-bus";
import { settingsGet } from "./config";
import * as orchestrator from "../agents/orchestrator";
import type { Database } from "./db";

let _db: Database | null = null;
const _unsubs: Array<() => void> = [];

/** Tracks repeated stall alerts per task to avoid flooding the chat. */
const _stallCounts = new Map<string, number>();

/** Exported for tests. */
export function _getStallCounts(): Map<string, number> { return _stallCounts; }

/** Check whether feedback is enabled (settings.proactive). */
function isProactive(): boolean {
  try {
    return settingsGet("proactive") !== false;
  } catch {
    return true; // Default to proactive if config is unreadable
  }
}

/** Look up a task title for context-rich messages. Returns the raw taskId string if not found. */
function taskLabel(taskId: string): string {
  if (!_db) return taskId;
  const task = _db.taskGet(taskId);
  if (!task) return taskId;
  return `${task.id} ("${task.title}")`;
}

/** Send a message to the orchestrator, catching errors to avoid crashing event handlers.
 *  Also persists the event as a system message and broadcasts it to WebSocket clients
 *  so the GUI shows the triggering event alongside the orchestrator's response. */
function safeSend(message: string, context: string): void {
  try {
    // Persist and broadcast as a system message so the chat UI shows the event
    const id = _db?.addMessage("system", message) ?? 0;
    bus.emit("message:new", {
      message: { id, source: "system", channel: "main", content: message, created_at: new Date().toISOString() },
    });

    orchestrator.sendMessage(message);
  } catch (err) {
    console.error(`[orchestrator-feedback] Failed to send ${context}:`, err);
    try { _db?.addEvent(null, null, "feedback_send_failed", `${context}: ${err}`); } catch {}
  }
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
      // Clear stall counter regardless of proactive setting — the worker is done.
      _stallCounts.delete(taskId);

      if (!isProactive()) return;
      // "done" means the worker completed its implementation step successfully —
      // the step engine will advance the pipeline. Notify for all other exits.
      if (status === "done") return;

      safeSend(
        `[event] Worker for ${taskLabel(taskId)} exited with status "${status}". ` +
        `The step engine will handle retries if configured. Review if this is unexpected.`,
        "worker:ended",
      );
    }),
  );

  // -- Evaluation outcomes ----------------------------------------------------

  _unsubs.push(
    bus.on("eval:passed", ({ taskId, feedback }) => {
      if (!isProactive()) return;
      const extra = feedback ? ` Feedback: ${feedback}` : "";
      safeSend(
        `[event] ${taskLabel(taskId)} passed evaluation — advancing to next pipeline step.${extra}`,
        "eval:passed",
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
      safeSend(
        `[event] ${taskLabel(taskId)} failed evaluation${retryInfo}. ` +
        `Failures: ${feedback}. Step engine will auto-retry if retries remain.`,
        "eval:failed",
      );
    }),
  );

  // -- Review outcomes --------------------------------------------------------

  _unsubs.push(
    bus.on("review:rejected", ({ taskId, feedback }) => {
      if (!isProactive()) return;
      safeSend(
        `[event] ${taskLabel(taskId)} review rejected. Feedback: ${feedback}. ` +
        `Should I restructure the approach or address the feedback directly?`,
        "review:rejected",
      );
    }),
  );

  _unsubs.push(
    bus.on("review:approved", ({ taskId }) => {
      if (!isProactive()) return;
      safeSend(
        `[event] ${taskLabel(taskId)} review approved — proceeding to next step.`,
        "review:approved",
      );
    }),
  );

  // -- Merge outcomes ---------------------------------------------------------

  _unsubs.push(
    bus.on("merge:pr_created", ({ taskId, prNumber, prUrl }) => {
      if (!isProactive()) return;
      safeSend(
        `[event] PR #${prNumber} created for ${taskLabel(taskId)}. URL: ${prUrl}`,
        "merge:pr_created",
      );
    }),
  );

  _unsubs.push(
    bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
      if (!isProactive()) return;
      safeSend(
        `[event] CI failed on PR #${prNumber} for ${taskLabel(taskId)}. ` +
        `Review the CI logs and decide: retry the worker, or escalate to the user.`,
        "merge:ci_failed",
      );
    }),
  );

  _unsubs.push(
    bus.on("merge:completed", ({ taskId, prNumber }) => {
      if (!isProactive()) return;
      const unblocked = _db?.getNewlyUnblocked(taskId) ?? [];
      const unblockedInfo = unblocked.length > 0
        ? ` ${unblocked.length} task(s) now unblocked: ${unblocked.map(t => t.id).join(", ")}.`
        : "";
      safeSend(
        `[event] ${taskLabel(taskId)} merged (PR #${prNumber}).${unblockedInfo}` +
        ` Plan next steps if needed.`,
        "merge:completed",
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
        safeSend(
          `[event] ${taskLabel(taskId)} failed${stepInfo}${retryInfo}. ` +
          `Retries exhausted — please review and decide how to proceed.`,
          "task:status:failed",
        );
      }
    }),
  );

  // -- Budget alerts ----------------------------------------------------------

  _unsubs.push(
    bus.on("cost:budget_warning", ({ current, limit, period }) => {
      if (!isProactive()) return;
      safeSend(
        `[budget] Warning: $${current.toFixed(2)}/$${limit.toFixed(2)} spent this ${period}. ` +
        `Consider pausing non-critical tasks.`,
        "cost:budget_warning",
      );
    }),
  );

  _unsubs.push(
    bus.on("cost:budget_exceeded", ({ current, limit, period }) => {
      if (!isProactive()) return;
      safeSend(
        `[budget] EXCEEDED: $${current.toFixed(2)}/$${limit.toFixed(2)} this ${period}. ` +
        `Worker spawning is paused. Waiting for user decision.`,
        "cost:budget_exceeded",
      );
    }),
  );

  // -- Health monitor alerts --------------------------------------------------

  _unsubs.push(
    bus.on("monitor:stall", ({ taskId, inactiveMinutes }) => {
      if (!isProactive()) return;

      const count = (_stallCounts.get(taskId) ?? 0) + 1;
      _stallCounts.set(taskId, count);

      const label = taskLabel(taskId);
      const stallMsg = count > 1
        ? `[health] ${label} worker stalled (×${count}) — no activity for ${inactiveMinutes} minutes. Should I restart it?`
        : `[health] ${label} worker stalled — no activity for ${inactiveMinutes} minutes. Should I restart it?`;

      // Always show the system message (with count), but only forward the
      // first stall per task to the orchestrator to avoid confused responses.
      const id = _db?.addMessage("system", stallMsg) ?? 0;
      bus.emit("message:new", {
        message: { id, source: "system", channel: "main", content: stallMsg, created_at: new Date().toISOString() },
      });

      if (count === 1) {
        try {
          orchestrator.sendMessage(stallMsg);
        } catch (err) {
          console.error("[orchestrator-feedback] Failed to send monitor:stall:", err);
          try { _db?.addEvent(null, null, "feedback_send_failed", `monitor:stall: ${err}`); } catch {}
        }
      }
    }),
  );

  _unsubs.push(
    bus.on("monitor:crash", ({ taskId }) => {
      if (!isProactive()) return;
      safeSend(
        `[health] ${taskLabel(taskId)} worker crashed. ` +
        `The step engine may auto-retry. Investigate if this recurs.`,
        "monitor:crash",
      );
    }),
  );
}

/** Tear down all subscriptions (for tests or shutdown). */
export function unwireOrchestratorFeedback(): void {
  for (const unsub of _unsubs) unsub();
  _unsubs.length = 0;
  _stallCounts.clear();
  _db = null;
}
