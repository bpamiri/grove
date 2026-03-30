// Grove v3 — Notification system types
import type { NotificationEventName } from "../shared/types";

export interface NotificationEvent {
  name: NotificationEventName;
  taskId: string | null;
  title: string;
  body: string;
  timestamp: number;
}

export interface NotificationChannel {
  name: string;
  events?: NotificationEventName[];  // if unset, receives all events
  send(event: NotificationEvent): Promise<void>;
}
