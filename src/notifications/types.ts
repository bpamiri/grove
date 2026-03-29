// Grove v3 — Notification system core types

export interface Notification {
  event: string;
  title: string;
  body: string;
  taskId?: string;
  severity: "info" | "warning" | "error";
  url?: string;
}

export interface NotificationChannel {
  name: string;
  send(notification: Notification): Promise<void>;
}

export interface NotificationRoutes {
  [eventType: string]: string[];
}
