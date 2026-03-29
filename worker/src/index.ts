// worker/src/index.ts — grove.cloud reverse proxy Worker
export interface Env {
  GROVE_ROUTES: KVNamespace;
}

interface RouteRecord {
  target: string;
  secret: string;
  expires: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") || "";

    // Registration endpoints (on bare domain or any subdomain)
    if (url.pathname === "/_grove/register") {
      if (request.method === "POST") return handleRegister(request, env);
      if (request.method === "DELETE") return handleDeregister(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/_grove/health") {
      return json({ ok: true, service: "grove.cloud" });
    }

    // Extract subdomain
    const subdomain = extractSubdomain(host);
    if (!subdomain) {
      return landingPage();
    }

    // Proxy to target
    return handleProxy(request, subdomain, env);
  },
} satisfies ExportedHandler<Env>;

async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: { subdomain?: string; target?: string; secret?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { subdomain, target, secret } = body;
  if (!subdomain || !target || !secret) {
    return json({ error: "Missing required fields: subdomain, target, secret" }, 400);
  }

  if (!/^[a-z0-9-]+$/.test(subdomain) || subdomain.length > 63) {
    return json({ error: "Invalid subdomain format" }, 400);
  }

  // Check ownership
  const existing = await env.GROVE_ROUTES.get<RouteRecord>(subdomain, "json");
  if (existing && existing.secret !== secret) {
    return json({ error: "Forbidden: secret mismatch" }, 403);
  }

  const record: RouteRecord = {
    target,
    secret,
    expires: Date.now() + TTL_MS,
  };
  await env.GROVE_ROUTES.put(subdomain, JSON.stringify(record));

  return json({ ok: true, url: `https://${subdomain}.grove.cloud` });
}

async function handleDeregister(request: Request, env: Env): Promise<Response> {
  let body: { subdomain?: string; secret?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { subdomain, secret } = body;
  if (!subdomain || !secret) {
    return json({ error: "Missing required fields: subdomain, secret" }, 400);
  }

  const existing = await env.GROVE_ROUTES.get<RouteRecord>(subdomain, "json");
  if (!existing) {
    return json({ ok: true }); // Already gone
  }
  if (existing.secret !== secret) {
    return json({ error: "Forbidden: secret mismatch" }, 403);
  }

  await env.GROVE_ROUTES.delete(subdomain);
  return json({ ok: true });
}

function extractSubdomain(host: string): string | null {
  const match = host.match(/^([a-z0-9-]+)\.grove\.cloud$/);
  return match ? match[1] : null;
}

function landingPage(): Response {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Grove</title>
<style>body{font-family:system-ui;background:#09090b;color:#a1a1aa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{text-align:center}h1{color:#34d399;font-size:1.5rem}a{color:#34d399}</style></head>
<body><div class="c"><h1>Grove</h1><p>Open source AI orchestrator</p>
<p><a href="https://github.com/bpamiri/grove">github.com/bpamiri/grove</a></p></div></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleProxy(
  request: Request,
  subdomain: string,
  env: Env,
): Promise<Response> {
  const record = await env.GROVE_ROUTES.get<RouteRecord>(subdomain, "json");

  if (!record || record.expires < Date.now()) {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Grove Offline</title>
<style>body{font-family:system-ui;background:#09090b;color:#a1a1aa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{text-align:center}h1{color:#f87171;font-size:1.5rem}</style></head>
<body><div class="c"><h1>This grove is offline</h1>
<p>The grove at <strong>${subdomain}.grove.cloud</strong> is not currently running.</p></div></body></html>`;
    return new Response(html, {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  // Rewrite the request URL to point at the quick-tunnel target
  const targetUrl = new URL(request.url);
  const target = new URL(record.target);
  targetUrl.hostname = target.hostname;
  targetUrl.port = target.port;
  targetUrl.protocol = target.protocol;

  // Forward the request (Workers handle WebSocket upgrades natively via fetch)
  const proxyReq = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });

  return fetch(proxyReq);
}
