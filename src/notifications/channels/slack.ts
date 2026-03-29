// Grove v3 — Slack notification channel (Block Kit)
import type { Notification, NotificationChannel } from "../types";

const SEVERITY_COLORS: Record<Notification["severity"], string> = {
  info: "#0E8A16",
  warning: "#FBCA04",
  error: "#B60205",
};

export function formatSlackPayload(notification: Notification): any {
  const contextText = `*Event:* ${notification.event}${notification.taskId ? ` | *Task:* ${notification.taskId}` : ""}`;

  return {
    attachments: [
      {
        color: SEVERITY_COLORS[notification.severity],
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${notification.title}*\n${notification.body}`,
            },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: contextText }],
          },
        ],
      },
    ],
  };
}

export function createSlackChannel(webhookUrl: string): NotificationChannel {
  return {
    name: "slack",
    async send(notification: Notification): Promise<void> {
      const payload = formatSlackPayload(notification);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`Slack webhook failed: ${res.status} ${res.statusText}`);
      }
    },
  };
}
