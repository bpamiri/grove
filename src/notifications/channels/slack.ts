// Grove v3 — Slack notification channel (webhook + Block Kit)
import type { SlackChannelConfig } from "../../shared/types";
import type { NotificationChannel, NotificationEvent } from "../types";

const COLORS: Record<string, string> = {
  task_completed: "#2eb67d",   // green
  task_failed: "#e01e5a",      // red
  gate_failed: "#e01e5a",
  ci_failed: "#e01e5a",
  pr_merged: "#2eb67d",
  budget_warning: "#ecb22e",   // yellow
  budget_exceeded: "#e01e5a",
  orchestrator_crashed: "#e01e5a",
};

export function buildSlackPayload(event: NotificationEvent): object {
  return {
    text: `${event.title}: ${event.body}`,
    attachments: [
      {
        color: COLORS[event.name] ?? "#36a64f",
        blocks: [
          { type: "header", text: { type: "plain_text", text: event.title, emoji: false } },
          { type: "section", text: { type: "mrkdwn", text: event.body } },
        ],
      },
    ],
  };
}

export function createSlackChannel(config: SlackChannelConfig): NotificationChannel {
  return {
    name: "slack",
    events: config.events,
    async send(event: NotificationEvent): Promise<void> {
      const payload = buildSlackPayload(event);
      const res = await fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
    },
  };
}
