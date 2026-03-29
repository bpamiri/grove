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
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Grove — AI Development Orchestrator</title>
  <style>
    body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#09090b;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .c{max-width:520px;text-align:center;padding:2rem}
    h1{font-size:2.5rem;margin:0 0 .25rem;color:#34d399}
    .sub{color:#71717a;margin-bottom:2rem;font-size:1.1rem}
    pre{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:1rem;text-align:left;overflow-x:auto;font-size:.875rem;color:#a1a1aa;cursor:pointer;position:relative}
    pre:hover{border-color:#34d399}
    pre:hover::after{content:'click to copy';position:absolute;top:.5rem;right:.75rem;color:#34d399;font-size:.7rem}
    code{color:#34d399}
    .features{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin:2rem 0;text-align:left}
    .feat{background:#18181b;border:1px solid #27272a;border-radius:6px;padding:.75rem;font-size:.8rem}
    .feat strong{color:#34d399;display:block;margin-bottom:.25rem}
    .feat span{color:#71717a}
    .links{margin-top:1.5rem;display:flex;gap:1.5rem;justify-content:center;font-size:.9rem}
    a{color:#34d399;text-decoration:none}a:hover{text-decoration:underline}
    @media(max-width:500px){.features{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="c">
    <h1>Grove</h1>
    <p class="sub">AI development orchestrator for Claude Code</p>
    <pre onclick="navigator.clipboard.writeText(this.textContent)"><code>curl -fsSL https://grove.cloud/install.sh | bash</code></pre>
    <div class="features">
      <div class="feat"><strong>Multi-repo</strong><span>Manage tasks across repos with isolated worktrees</span></div>
      <div class="feat"><strong>Quality gates</strong><span>Tests, lint, diff size checks before merge</span></div>
      <div class="feat"><strong>Cost control</strong><span>Per-task, daily, and weekly budget limits</span></div>
      <div class="feat"><strong>Web dashboard</strong><span>Real-time task monitoring via tunnel</span></div>
    </div>
    <div class="links">
      <a href="https://github.com/bpamiri/grove">GitHub</a>
      <a href="https://github.com/bpamiri/grove#getting-started">Docs</a>
    </div>
  </div>
</body>
</html>`;
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

  // Rewrite headers: set Host to target hostname so the tunnel accepts the request
  const headers = new Headers(request.headers);
  headers.set("host", target.hostname);

  // Forward the request (Workers handle WebSocket upgrades natively via fetch)
  const proxyReq = new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });

  return fetch(proxyReq);
}
