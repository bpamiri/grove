// Grove v3 — System notification channel (macOS osascript / Linux notify-send)
import type { SystemChannelConfig } from "../../shared/types";
import type { NotificationChannel, NotificationEvent } from "../types";

export function parseHour(time: string): number {
  const [h] = time.split(":");
  return parseInt(h, 10);
}

export function isQuietHours(quietHours: SystemChannelConfig["quiet_hours"], nowHour?: number): boolean {
  if (!quietHours) return false;
  const h = nowHour ?? new Date().getHours();
  const start = parseHour(quietHours.start);
  const end = parseHour(quietHours.end);
  // Wraps midnight: e.g. start=22, end=7 means 22-23 and 0-6
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

export function createSystemChannel(config: SystemChannelConfig): NotificationChannel {
  return {
    name: "system",
    events: config.events,
    async send(event: NotificationEvent): Promise<void> {
      if (!config.enabled) return;
      if (isQuietHours(config.quiet_hours)) return;

      const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const title = escape(event.title);
      const body = escape(event.body);

      if (process.platform === "darwin") {
        Bun.spawnSync(["osascript", "-e", `display notification "${body}" with title "${title}"`]);
      } else {
        Bun.spawnSync(["notify-send", title, body]);
      }
    },
  };
}
