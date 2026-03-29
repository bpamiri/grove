// Grove v3 — System notification channel (macOS + Linux)
import type { Notification, NotificationChannel } from "../types";

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isInQuietHours(
  start: string | undefined,
  end: string | undefined,
): boolean {
  if (start === undefined || end === undefined) return false;

  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const s = parseMinutes(start);
  const e = parseMinutes(end);

  // Overnight range (e.g. 22:00–07:00)
  if (s > e) return current >= s || current < e;

  return current >= s && current < e;
}

function sanitize(str: string, maxLen: number): string {
  return str.slice(0, maxLen).replace(/"/g, '\\"');
}

export function createSystemChannel(quietHours?: {
  start?: string;
  end?: string;
}): NotificationChannel {
  return {
    name: "system",
    async send(notification: Notification): Promise<void> {
      if (isInQuietHours(quietHours?.start, quietHours?.end)) return;

      const title = sanitize(notification.title, 100);
      const body = sanitize(notification.body, 200);

      if (process.platform === "darwin") {
        Bun.spawnSync([
          "osascript",
          "-e",
          `display notification "${body}" with title "Grove" subtitle "${title}"`,
        ]);
      } else {
        Bun.spawnSync(["notify-send", "Grove", `${title}\n${body}`]);
      }
    },
  };
}
