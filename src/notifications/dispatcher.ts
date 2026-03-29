// Grove v3 — Notification dispatcher: routes events to channels with rate limiting

import type { Notification, NotificationChannel, NotificationRoutes } from "./types";

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

const channels = new Map<string, NotificationChannel>();

export function registerChannel(channel: NotificationChannel): void {
  channels.set(channel.name, channel);
}

// ---------------------------------------------------------------------------
// buildNotification
// ---------------------------------------------------------------------------

interface NotificationCtx {
  taskId?: string;
  title?: string;
  feedback?: string;
  prNumber?: number;
  current?: number;
  limit?: number;
  period?: string;
}

export function buildNotification(event: string, ctx: NotificationCtx): Notification {
  const taskPrefix = ctx.taskId ? `[${ctx.taskId}] ` : "";

  switch (event) {
    case "task_completed":
      return {
        event,
        taskId: ctx.taskId,
        severity: "info",
        title: `${taskPrefix}Task completed`,
        body: ctx.title ? `${ctx.title} finished successfully.` : "Task finished successfully.",
      };

    case "task_failed":
      return {
        event,
        taskId: ctx.taskId,
        severity: "error",
        title: `${taskPrefix}Task failed`,
        body: ctx.feedback ? `Feedback: ${ctx.feedback}` : "Task failed without feedback.",
      };

    case "gate_failed":
      return {
        event,
        taskId: ctx.taskId,
        severity: "warning",
        title: `${taskPrefix}Quality gate failed`,
        body: ctx.feedback ? ctx.feedback : "A quality gate did not pass.",
      };

    case "pr_merged":
      return {
        event,
        taskId: ctx.taskId,
        severity: "info",
        title: `${taskPrefix}PR merged`,
        body: ctx.prNumber ? `Pull request #${ctx.prNumber} was merged.` : "Pull request was merged.",
      };

    case "ci_failed":
      return {
        event,
        taskId: ctx.taskId,
        severity: "error",
        title: `${taskPrefix}CI failed`,
        body: ctx.feedback ? ctx.feedback : "CI pipeline failed.",
      };

    case "budget_warning":
      return {
        event,
        taskId: ctx.taskId,
        severity: "warning",
        title: `${taskPrefix}Budget warning`,
        body:
          ctx.current !== undefined && ctx.limit !== undefined
            ? `Spend $${ctx.current.toFixed(2)} approaching limit $${ctx.limit.toFixed(2)}${ctx.period ? ` (${ctx.period})` : ""}.`
            : "Approaching budget limit.",
      };

    case "budget_exceeded":
      return {
        event,
        taskId: ctx.taskId,
        severity: "error",
        title: `${taskPrefix}Budget exceeded`,
        body:
          ctx.current !== undefined && ctx.limit !== undefined
            ? `Spend $${ctx.current.toFixed(2)} exceeded limit $${ctx.limit.toFixed(2)}${ctx.period ? ` (${ctx.period})` : ""}.`
            : "Budget limit exceeded.",
      };

    case "orchestrator_crashed":
      return {
        event,
        taskId: ctx.taskId,
        severity: "error",
        title: "Orchestrator crashed",
        body: ctx.feedback ? ctx.feedback : "The orchestrator process crashed unexpectedly.",
      };

    default:
      return {
        event,
        taskId: ctx.taskId,
        severity: "info",
        title: `${taskPrefix}${event}`,
        body: ctx.title ?? event,
      };
  }
}

// ---------------------------------------------------------------------------
// shouldNotify
// ---------------------------------------------------------------------------

export function shouldNotify(event: string, routes: NotificationRoutes): boolean {
  const targets = routes[event];
  return Array.isArray(targets) && targets.length > 0;
}

// ---------------------------------------------------------------------------
// dispatch — with per-event rate limiting (max 1 per 60s)
// ---------------------------------------------------------------------------

const lastSentAt = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

export async function dispatch(notification: Notification, routes: NotificationRoutes): Promise<void> {
  if (!shouldNotify(notification.event, routes)) return;

  const now = Date.now();
  const last = lastSentAt.get(notification.event) ?? 0;
  if (now - last < RATE_LIMIT_MS) return;

  lastSentAt.set(notification.event, now);

  const channelNames = routes[notification.event];
  await Promise.all(
    channelNames.map((name) => {
      const ch = channels.get(name);
      return ch ? ch.send(notification) : Promise.resolve();
    })
  );
}
