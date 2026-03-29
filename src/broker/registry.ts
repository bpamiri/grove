// Grove v3 — Registry client for grove.cloud Worker proxy
// Registers the grove's quick-tunnel URL under a stable subdomain.

export interface RegisterOpts {
  registryUrl: string;  // e.g. "https://grove.cloud"
  subdomain: string;
  target: string;       // quick-tunnel URL
  secret: string;
}

export interface DeregisterOpts {
  registryUrl: string;
  subdomain: string;
  secret: string;
}

/** Register or update a subdomain→target mapping with the grove.cloud Worker */
export async function registerGrove(opts: RegisterOpts): Promise<string> {
  const resp = await fetch(`${opts.registryUrl}/_grove/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subdomain: opts.subdomain,
      target: opts.target,
      secret: opts.secret,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Registry registration failed (${resp.status}): ${body}`);
  }

  const data = await resp.json() as { ok: boolean; url: string };
  return data.url;
}

/** Deregister a subdomain (cleanup on shutdown or rotation) */
export async function deregisterGrove(opts: DeregisterOpts): Promise<void> {
  const resp = await fetch(`${opts.registryUrl}/_grove/register`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subdomain: opts.subdomain,
      secret: opts.secret,
    }),
  });

  // Best-effort — don't throw on failure
  if (!resp.ok) {
    console.log(`Registry deregister failed (${resp.status}) — ignoring`);
  }
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** Start periodic heartbeat to keep registration alive */
export function startHeartbeat(opts: RegisterOpts): void {
  stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    try {
      await registerGrove(opts);
    } catch (err: any) {
      console.log(`Registry heartbeat failed: ${err.message}`);
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

/** Stop the heartbeat */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
