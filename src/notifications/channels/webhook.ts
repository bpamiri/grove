// Grove v3 — Generic webhook notification channel with HMAC-SHA256 signing
import type { WebhookChannelConfig } from "../../shared/types";
import type { NotificationChannel, NotificationEvent } from "../types";

export async function signPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createWebhookChannel(config: WebhookChannelConfig): NotificationChannel {
  return {
    name: "webhook",
    events: config.events,
    async send(event: NotificationEvent): Promise<void> {
      const payload = JSON.stringify(event);
      const sig = await signPayload(config.secret, payload);
      const res = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": `sha256=${sig}`,
        },
        body: payload,
      });
      if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
    },
  };
}
