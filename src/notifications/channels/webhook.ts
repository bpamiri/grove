// Grove v3 — Generic webhook notification channel with optional HMAC-SHA256 signing
import type { Notification, NotificationChannel } from "../types";

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function createWebhookChannel(url: string, secret?: string): NotificationChannel {
  return {
    name: "webhook",
    async send(notification: Notification): Promise<void> {
      const payload = JSON.stringify({
        event: notification.event,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        taskId: notification.taskId,
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (secret) {
        headers["X-Grove-Signature"] = await hmacSign(payload, secret);
      }

      const doPost = () => fetch(url, { method: "POST", headers, body: payload });

      let res = await doPost();
      if (res.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        res = await doPost();
      }

      if (!res.ok) {
        throw new Error(`Webhook POST failed: ${res.status} ${res.statusText}`);
      }
    },
  };
}
