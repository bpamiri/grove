// Grove v3 — Notification dispatcher with rate limiting
import type { NotificationEventName } from "../shared/types";
import type { NotificationChannel, NotificationEvent } from "./types";

// Rate limit: "eventName:taskId" → last-sent epoch ms
const _sent = new Map<string, number>();
const RATE_MS = 60_000;

function rateLimitKey(event: NotificationEventName, taskId: string | null): string {
  return `${event}:${taskId ?? "_"}`;
}

function isRateLimited(event: NotificationEventName, taskId: string | null): boolean {
  const last = _sent.get(rateLimitKey(event, taskId)) ?? 0;
  return Date.now() - last < RATE_MS;
}

function markSent(event: NotificationEventName, taskId: string | null): void {
  _sent.set(rateLimitKey(event, taskId), Date.now());
}

function wantsEvent(channel: NotificationChannel, event: NotificationEventName): boolean {
  return !channel.events || channel.events.includes(event);
}

export function dispatch(channels: NotificationChannel[], event: NotificationEvent): void {
  if (isRateLimited(event.name, event.taskId)) return;
  markSent(event.name, event.taskId);

  for (const channel of channels) {
    if (!wantsEvent(channel, event.name)) continue;
    channel.send(event).catch((err) => {
      console.error(`[notify:${channel.name}]`, err);
    });
  }
}

export function resetRateLimiter(): void {
  _sent.clear();
}
