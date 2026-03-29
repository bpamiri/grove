// Grove v3 — Wire notification channels into the event bus
import { bus } from "../broker/event-bus";
import { buildNotification, dispatch, registerChannel } from "./dispatcher";
import { createSlackChannel } from "./channels/slack";
import { createSystemChannel } from "./channels/system";
import { createWebhookChannel } from "./channels/webhook";
import type { NotificationConfig } from "../shared/types";

export function wireNotifications(config?: NotificationConfig): void {
  if (!config) return;

  const routes = config.routes ?? {};

  // Register channels
  if (config.channels?.slack) {
    const url = config.channels.slack.webhook_url
      ?? (config.channels.slack.env ? process.env[config.channels.slack.env] : undefined);
    if (url) registerChannel(createSlackChannel(url));
  }

  if (config.channels?.system?.enabled !== false) {
    registerChannel(createSystemChannel(config.quiet_hours));
  }

  if (config.channels?.webhook?.url) {
    registerChannel(createWebhookChannel(config.channels.webhook.url, config.channels.webhook.secret));
  }

  // Subscribe to events
  bus.on("task:status", ({ taskId, status }) => {
    if (status === "completed") {
      dispatch(buildNotification("task_completed", { taskId }), routes);
    }
    if (status === "failed") {
      dispatch(buildNotification("task_failed", { taskId }), routes);
    }
  });

  bus.on("eval:failed", ({ taskId, feedback }) => {
    dispatch(buildNotification("gate_failed", { taskId, feedback }), routes);
  });

  bus.on("merge:completed", ({ taskId, prNumber }) => {
    dispatch(buildNotification("pr_merged", { taskId, prNumber }), routes);
  });

  bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
    dispatch(buildNotification("ci_failed", { taskId, prNumber }), routes);
  });

  bus.on("cost:budget_warning", ({ current, limit, period }) => {
    dispatch(buildNotification("budget_warning", { current, limit, period }), routes);
  });

  bus.on("cost:budget_exceeded", ({ current, limit, period }) => {
    dispatch(buildNotification("budget_exceeded", { current, limit, period }), routes);
  });

  bus.on("monitor:crash", ({ taskId }) => {
    dispatch(buildNotification("orchestrator_crashed", { taskId }), routes);
  });
}
