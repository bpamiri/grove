// Grove v3 — Notification event bus wiring
import { bus } from "../broker/event-bus";
import { notificationsConfig } from "../broker/config";
import type { NotificationEvent } from "./types";
import type { NotificationEventName } from "../shared/types";
import { dispatch } from "./dispatcher";
import { createSlackChannel } from "./channels/slack";
import { createSystemChannel } from "./channels/system";
import { createWebhookChannel } from "./channels/webhook";

let _wired = false;

function buildEvent(name: NotificationEventName, taskId: string | null, title: string, body: string): NotificationEvent {
  return { name, taskId, title, body, timestamp: Date.now() };
}

export function wireNotifications(): void {
  if (_wired) return;
  _wired = true;

  const cfg = notificationsConfig();
  if (!cfg) return;

  // Build active channels from config
  const channels: NotificationChannel[] = [];
  if (cfg.slack?.webhook_url) channels.push(createSlackChannel(cfg.slack));
  if (cfg.system?.enabled) channels.push(createSystemChannel(cfg.system));
  if (cfg.webhook?.url && cfg.webhook?.secret) channels.push(createWebhookChannel(cfg.webhook));

  if (channels.length === 0) return;

  bus.on("task:status", ({ taskId, status }) => {
    if (status === "completed") {
      dispatch(channels, buildEvent("task_completed", taskId, "Task Completed", `Task ${taskId} completed successfully`));
    }
    if (status === "failed") {
      dispatch(channels, buildEvent("task_failed", taskId, "Task Failed", `Task ${taskId} failed`));
    }
  });

  bus.on("gate:result", ({ taskId, gate, passed, message }) => {
    if (!passed) {
      dispatch(channels, buildEvent("gate_failed", taskId, "Gate Failed", `Task ${taskId}: ${gate} — ${message}`));
    }
  });

  bus.on("merge:completed", ({ taskId, prNumber }) => {
    dispatch(channels, buildEvent("pr_merged", taskId, "PR Merged", `Task ${taskId}: PR #${prNumber} merged`));
  });

  bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
    dispatch(channels, buildEvent("ci_failed", taskId, "CI Failed", `Task ${taskId}: CI failed on PR #${prNumber}`));
  });

  bus.on("cost:budget_warning", ({ current, limit, period }) => {
    dispatch(channels, buildEvent("budget_warning", null, "Budget Warning", `${period}: $${current.toFixed(2)} of $${limit.toFixed(2)} limit`));
  });

  bus.on("cost:budget_exceeded", ({ current, limit, period }) => {
    dispatch(channels, buildEvent("budget_exceeded", null, "Budget Exceeded", `${period}: $${current.toFixed(2)} exceeded $${limit.toFixed(2)} limit`));
  });

  bus.on("monitor:crash", ({ taskId, sessionId }) => {
    dispatch(channels, buildEvent("orchestrator_crashed", taskId, "Orchestrator Crashed", `Session ${sessionId} crashed for task ${taskId}`));
  });
}
