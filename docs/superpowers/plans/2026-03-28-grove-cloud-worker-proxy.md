# grove.cloud Worker Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace named Cloudflare tunnels with a shared Worker proxy on `grove.cloud` that gives any grove instance a stable vanity URL backed by ephemeral quick tunnels.

**Architecture:** A Cloudflare Worker on `grove.cloud` acts as a reverse proxy. Grove instances register their quick-tunnel URLs with the Worker under stable subdomains. The Worker proxies all traffic (including WebSockets) to the current tunnel target. Registration uses a first-claim-with-secret model and TTL-based expiry.

**Tech Stack:** Cloudflare Workers (TypeScript), Workers KV, Bun (grove broker), `wrangler` CLI for deployment.

**Spec:** `docs/superpowers/specs/2026-03-28-grove-cloud-worker-proxy.md`

---

### Task 1: Install wrangler and scaffold Worker project

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.ts` (stub)
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`

- [ ] **Step 1: Install wrangler globally**

Run: `bun install -g wrangler`
Expected: wrangler installed, `wrangler --version` outputs a version number.

- [ ] **Step 2: Create worker directory and package.json**

```json
// worker/package.json
{
  "name": "grove-cloud-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4"
  }
}
```

- [ ] **Step 3: Create wrangler.toml**

```toml
# worker/wrangler.toml
name = "grove-cloud"
main = "src/index.ts"
compatibility_date = "2026-03-28"

routes = [
  { pattern = "grove.cloud/*", zone_name = "grove.cloud" },
  { pattern = "*.grove.cloud/*", zone_name = "grove.cloud" }
]

[[kv_namespaces]]
binding = "GROVE_ROUTES"
id = "__FILL_AFTER_KV_CREATE__"
```

Note: The KV namespace ID gets filled in after `wrangler kv namespace create GROVE_ROUTES`.

- [ ] **Step 4: Create tsconfig.json**

```json
// worker/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create stub Worker**

```typescript
// worker/src/index.ts
export interface Env {
  GROVE_ROUTES: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("grove.cloud worker running", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Install worker dependencies**

Run: `cd worker && bun install`

- [ ] **Step 7: Verify wrangler dev works**

Run: `cd worker && wrangler dev --local`
Expected: Worker starts on a local port, returns "grove.cloud worker running".
Stop with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add worker/
git commit -m "feat: scaffold grove.cloud Cloudflare Worker project"
```

---

### Task 2: Implement Worker registration endpoints

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Define KV record type and helper**

Replace the contents of `worker/src/index.ts` with:

```typescript
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
```

- [ ] **Step 2: Implement registration handler**

Append to `worker/src/index.ts`:

```typescript
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
```

- [ ] **Step 3: Implement subdomain extraction and landing page**

Append to `worker/src/index.ts`:

```typescript
function extractSubdomain(host: string): string | null {
  // host = "cedar-ridge-7kx2.grove.cloud" → "cedar-ridge-7kx2"
  // host = "grove.cloud" → null
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
```

- [ ] **Step 4: Implement proxy handler**

Append to `worker/src/index.ts`:

```typescript
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
```

- [ ] **Step 5: Verify locally with wrangler dev**

Run: `cd worker && wrangler dev --local`

Test registration:
```bash
curl -X POST http://localhost:8787/_grove/register \
  -H "Content-Type: application/json" \
  -d '{"subdomain":"test-grove","target":"https://example.com","secret":"abc123"}'
```
Expected: `{"ok":true,"url":"https://test-grove.grove.cloud"}`

Test health:
```bash
curl http://localhost:8787/_grove/health
```
Expected: `{"ok":true,"service":"grove.cloud"}`

Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: implement grove.cloud Worker with registration + proxy"
```

---

### Task 3: Create KV namespace and deploy Worker

**Files:**
- Modify: `worker/wrangler.toml` (fill in KV ID)

- [ ] **Step 1: Login to Cloudflare via wrangler**

Run: `cd worker && wrangler login`
Expected: Browser opens, authorize wrangler for the grove.cloud account.

- [ ] **Step 2: Create KV namespace**

Run: `cd worker && wrangler kv namespace create GROVE_ROUTES`
Expected: Output includes a namespace ID like `{ binding = "GROVE_ROUTES", id = "abc123..." }`.

- [ ] **Step 3: Update wrangler.toml with real KV ID**

Replace `__FILL_AFTER_KV_CREATE__` in `worker/wrangler.toml` with the actual ID from step 2.

- [ ] **Step 4: Deploy Worker**

Run: `cd worker && wrangler deploy`
Expected: Worker deployed to `grove.cloud`.

- [ ] **Step 5: Update DNS — remove old tunnel CNAMEs, add Worker route**

In the Cloudflare dashboard for `grove.cloud`:
- Delete the `@` CNAME pointing to the old tunnel UUID.
- Delete the `*` wildcard CNAME pointing to the old tunnel UUID.
- The Worker routes in `wrangler.toml` handle routing — no DNS changes needed once the Worker is deployed with zone routes.

- [ ] **Step 6: Verify deployed Worker**

```bash
curl https://grove.cloud/_grove/health
```
Expected: `{"ok":true,"service":"grove.cloud"}`

```bash
curl https://grove.cloud/
```
Expected: Landing page HTML.

- [ ] **Step 7: Commit**

```bash
git add worker/wrangler.toml
git commit -m "feat: deploy grove.cloud Worker with KV namespace"
```

---

### Task 4: Add `generateSecret()` to subdomain module

**Files:**
- Modify: `src/broker/subdomain.ts`
- Test: `tests/broker/subdomain.test.ts`

- [ ] **Step 1: Write test for generateSecret**

Create `tests/broker/subdomain.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { generateSubdomain, generateSecret } from "../../src/broker/subdomain";

describe("generateSubdomain", () => {
  test("returns word-word-suffix format", () => {
    const sub = generateSubdomain();
    expect(sub).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  test("generates unique values", () => {
    const a = generateSubdomain();
    const b = generateSubdomain();
    expect(a).not.toBe(b);
  });
});

describe("generateSecret", () => {
  test("returns 32-char hex string", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[a-f0-9]{32}$/);
    expect(secret.length).toBe(32);
  });

  test("generates unique values", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/subdomain.test.ts`
Expected: FAIL — `generateSecret` is not exported.

- [ ] **Step 3: Add generateSecret to subdomain.ts**

Add to the end of `src/broker/subdomain.ts`:

```typescript
/** Generate a 32-char hex secret for registration ownership */
export function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/broker/subdomain.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/broker/subdomain.ts tests/broker/subdomain.test.ts
git commit -m "feat: add generateSecret for registry ownership"
```

---

### Task 5: Create registry client module

**Files:**
- Create: `src/broker/registry.ts`
- Test: `tests/broker/registry.test.ts`

- [ ] **Step 1: Write test for registry client**

Create `tests/broker/registry.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { registerGrove, deregisterGrove } from "../../src/broker/registry";

// Mock global fetch
const originalFetch = globalThis.fetch;

describe("registerGrove", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST with correct body and returns url", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (input: any, init: any) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true, url: "https://test.grove.cloud" }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await registerGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "abc123",
    });

    expect(capturedUrl).toBe("https://grove.cloud/_grove/register");
    expect(JSON.parse(capturedBody)).toEqual({
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "abc123",
    });
    expect(result).toBe("https://test.grove.cloud");
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });

    expect(registerGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      target: "https://random.trycloudflare.com",
      secret: "wrong",
    })).rejects.toThrow();
  });
});

describe("deregisterGrove", () => {
  test("sends DELETE with correct body", async () => {
    let capturedMethod = "";
    let capturedBody = "";

    globalThis.fetch = async (_input: any, init: any) => {
      capturedMethod = init?.method;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true }));
    };

    await deregisterGrove({
      registryUrl: "https://grove.cloud",
      subdomain: "test-sub",
      secret: "abc123",
    });

    expect(capturedMethod).toBe("DELETE");
    expect(JSON.parse(capturedBody)).toEqual({
      subdomain: "test-sub",
      secret: "abc123",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement registry.ts**

Create `src/broker/registry.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/broker/registry.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/broker/registry.ts tests/broker/registry.test.ts
git commit -m "feat: add grove.cloud registry client with heartbeat"
```

---

### Task 6: Simplify tunnel module — remove named-tunnel code

**Files:**
- Modify: `src/tunnel/cloudflare.ts`

- [ ] **Step 1: Rewrite cloudflare.ts to quick-tunnel only**

Replace the entire contents of `src/tunnel/cloudflare.ts` with:

```typescript
// Grove v3 — Cloudflare quick tunnel provider
// Spawns `cloudflared tunnel --url http://localhost:{port}` and parses the assigned URL.
import type { TunnelProvider } from "./provider";

export class CloudflareTunnel implements TunnelProvider {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private url: string | null = null;
  private pid: number | null = null;

  async start(localPort: number): Promise<string> {
    if (this.proc && this.isRunning()) {
      return this.url!;
    }

    // Check if cloudflared is available
    const which = Bun.spawnSync(["which", "cloudflared"]);
    if (which.exitCode !== 0) {
      throw new Error(
        "cloudflared is not installed. Install it with:\n" +
        "  brew install cloudflared\n" +
        "Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      );
    }

    return new Promise<string>((resolve, reject) => {
      const proc = Bun.spawn(
        ["cloudflared", "tunnel", "--url", `http://localhost:${localPort}`],
        { stdout: "pipe", stderr: "pipe" },
      );

      this.proc = proc;
      this.pid = proc.pid;

      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for cloudflared to assign a URL (30s)"));
      }, 30_000);

      this.readStderrForUrl(proc, (url) => {
        clearTimeout(timeout);
        this.url = url;
        resolve(url);
      }, (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async readStderrForUrl(
    proc: ReturnType<typeof Bun.spawn>,
    onUrl: (url: string) => void,
    onError: (err: Error) => void,
  ) {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") {
      onError(new Error("No stderr stream from cloudflared"));
      return;
    }

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    let found = false;

    try {
      while (!found) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);

        const urlMatch = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch) {
          found = true;
          onUrl(urlMatch[0]);
        }
      }

      if (!found) {
        onError(new Error("cloudflared exited without providing a URL"));
      }
    } catch (err) {
      if (!found) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.pid = null;
      this.url = null;
    }
  }

  getUrl(): string | null {
    return this.url;
  }

  isRunning(): boolean {
    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `bun build src/tunnel/cloudflare.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tunnel/cloudflare.ts
git commit -m "refactor: simplify tunnel to quick-tunnels only, remove named-tunnel code"
```

---

### Task 7: Update TunnelConfig type

**Files:**
- Modify: `src/shared/types.ts:185-191`

- [ ] **Step 1: Update TunnelConfig**

Replace the `TunnelConfig` interface in `src/shared/types.ts` (lines 185-191):

```typescript
export interface TunnelConfig {
  provider: "cloudflare" | "bore" | "ngrok";
  auth: "token" | "none";
  domain?: string;      // e.g. "grove.cloud" — register with Worker proxy for stable vanity URL
  subdomain?: string;   // auto-generated on first start, persisted across restarts
  secret?: string;      // auto-generated, proves subdomain ownership with Worker
}
```

- [ ] **Step 2: Verify no type errors**

Run: `bun build src/shared/types.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "refactor: TunnelConfig — replace name with secret, remove named-tunnel field"
```

---

### Task 8: Wire registry into broker startup and shutdown

**Files:**
- Modify: `src/broker/index.ts`

- [ ] **Step 1: Update imports**

In `src/broker/index.ts`, replace the imports section (lines 1-17):

```typescript
// Grove v3 — Broker main process
// Starts HTTP server, tmux session, orchestrator, and manages lifecycle.
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { Database, getEnv } from "./db";
import { startServer, stopServer, setRemoteUrl } from "./server";
import * as tmux from "./tmux";
import * as orchestrator from "../agents/orchestrator";
import { loadConfig, configTrees, tunnelConfig, configSet } from "./config";
import { bus } from "./event-bus";
import { wireStepEngine } from "../engine/step-engine";
import { initDispatch } from "./dispatch";
import { startHealthMonitor, stopHealthMonitor, recoverOrphanedTasks } from "../monitor/health";
import { startCostMonitor, stopCostMonitor } from "../monitor/cost";
import { CloudflareTunnel } from "../tunnel/cloudflare";
import type { TunnelProvider } from "../tunnel/provider";
import { generateSubdomain, generateSecret } from "./subdomain";
import { registerGrove, startHeartbeat, stopHeartbeat, deregisterGrove } from "./registry";
```

- [ ] **Step 2: Add tunnelUrl to BrokerInfo**

Update the `BrokerInfo` interface (around line 19):

```typescript
export interface BrokerInfo {
  pid: number;
  port: number;
  url: string;
  tunnelUrl: string | null;  // raw quick-tunnel URL (trycloudflare.com)
  remoteUrl: string | null;  // vanity URL (grove.cloud) or tunnel URL if no domain
  tmuxSession: string;
  startedAt: string;
}
```

- [ ] **Step 3: Rewrite tunnel startup section**

Replace the tunnel startup block (lines 106-124) with:

```typescript
  // Start tunnel (if configured)
  let tunnelUrl: string | null = null;
  let remoteUrl: string | null = null;
  const tConfig = tunnelConfig();
  if (tConfig.provider === "cloudflare") {
    try {
      tunnel = new CloudflareTunnel();
      tunnelUrl = await tunnel.start(port);

      // Register with grove.cloud Worker if domain is configured
      if (tConfig.domain) {
        // Generate subdomain + secret on first run
        if (!tConfig.subdomain) {
          tConfig.subdomain = generateSubdomain();
          configSet("tunnel.subdomain", tConfig.subdomain);
        }
        if (!tConfig.secret) {
          tConfig.secret = generateSecret();
          configSet("tunnel.secret", tConfig.secret);
        }

        try {
          const registryUrl = `https://${tConfig.domain}`;
          remoteUrl = await registerGrove({
            registryUrl,
            subdomain: tConfig.subdomain,
            target: tunnelUrl,
            secret: tConfig.secret,
          });
          setRemoteUrl(remoteUrl);
          startHeartbeat({
            registryUrl,
            subdomain: tConfig.subdomain,
            target: tunnelUrl,
            secret: tConfig.secret,
          });
        } catch (err: any) {
          console.log(`  Registry: ${err.message}`);
          // Fall back to raw tunnel URL
          remoteUrl = tunnelUrl;
          setRemoteUrl(remoteUrl);
        }
      } else {
        remoteUrl = tunnelUrl;
        setRemoteUrl(remoteUrl);
      }
    } catch (err: any) {
      console.log(`  Tunnel: ${err.message}`);
      // Non-fatal — continue without tunnel
    }
  }
```

- [ ] **Step 4: Update BrokerInfo construction**

Replace the broker info block (around line 126-135):

```typescript
  // Write broker info file
  const info: BrokerInfo = {
    pid: process.pid,
    port,
    url,
    tunnelUrl,
    remoteUrl,
    tmuxSession: "grove",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(GROVE_HOME, "broker.json"), JSON.stringify(info, null, 2));
```

- [ ] **Step 5: Add deregister + heartbeat stop to shutdown handler**

Update the shutdown handler (around line 140). Add `stopHeartbeat()` and deregister before existing cleanup:

```typescript
  const shutdown = () => {
    console.log("\nShutting down...");
    stopHealthMonitor();
    stopCostMonitor();
    stopHeartbeat();
    // Deregister from grove.cloud (best-effort, non-blocking)
    const tc = tunnelConfig();
    if (tc.domain && tc.subdomain && tc.secret) {
      deregisterGrove({
        registryUrl: `https://${tc.domain}`,
        subdomain: tc.subdomain,
        secret: tc.secret,
      }).catch(() => {});
    }
    tunnel?.stop();
    orchestrator.stop(db);
    tmux.killSession();
    stopServer();
    db.addEvent(null, null, "broker_stopped", "Broker stopped");
    db.close();
    // Remove broker.json
    try { Bun.spawnSync(["rm", "-f", join(GROVE_HOME, "broker.json")]); } catch {}
    process.exit(0);
  };
```

- [ ] **Step 6: Verify build succeeds**

Run: `bun build src/broker/index.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/broker/index.ts
git commit -m "feat: wire registry into broker startup/shutdown with heartbeat"
```

---

### Task 9: Update CLI output to show both URLs

**Files:**
- Modify: `src/cli/commands/up.ts`

- [ ] **Step 1: Update up.ts to show tunnel + remote URLs**

Replace the entire contents of `src/cli/commands/up.ts`:

```typescript
// grove up — Start broker + orchestrator + tunnel
import pc from "picocolors";
import { startBroker, readBrokerInfo } from "../../broker/index";
import { getOrCreateToken } from "../../broker/auth";

export async function run(_args: string[]) {
  // Check if already running
  const existing = readBrokerInfo();
  if (existing) {
    console.log(`${pc.yellow("Grove is already running.")}`);
    console.log(`  Local:  ${pc.bold(existing.url)}`);
    console.log(`  tmux:   ${pc.dim("tmux attach -t grove")}`);
    return;
  }

  console.log(`${pc.green("Starting Grove...")}`)

  try {
    const info = await startBroker();
    const token = getOrCreateToken();

    console.log();
    console.log(`  ${pc.green("✓")} Broker started (PID ${info.pid})`);
    console.log(`  ${pc.green("✓")} Orchestrator spawned in tmux:grove`);
    if (info.tunnelUrl) {
      console.log(`  ${pc.green("✓")} Tunnel active`);
    }
    if (info.remoteUrl && info.remoteUrl !== info.tunnelUrl) {
      console.log(`  ${pc.green("✓")} Registered on grove.cloud`);
    }
    console.log();
    console.log(`  Local:   ${pc.bold(info.url)}`);
    if (info.tunnelUrl) {
      console.log(`  Tunnel:  ${pc.dim(info.tunnelUrl)}`);
    }
    if (info.remoteUrl) {
      console.log(`  Remote:  ${pc.bold(`${info.remoteUrl}?token=${token}`)}`);
    }
    console.log(`  tmux:    ${pc.dim("tmux attach -t grove")}`);
    console.log();
    console.log(`${pc.dim("Press Ctrl+C to stop.")}`);

    // Keep the process alive
    await new Promise(() => {});
  } catch (err: any) {
    console.error(`${pc.red("Failed to start:")} ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/up.ts
git commit -m "feat: CLI shows both tunnel and remote URLs"
```

---

### Task 10: Update rotate-credentials endpoint for registry

**Files:**
- Modify: `src/broker/server.ts:538-563`

- [ ] **Step 1: Rewrite rotate-credentials handler**

Replace the `POST /api/rotate-credentials` block in `src/broker/server.ts` (lines 538-563):

```typescript
    // POST /api/rotate-credentials — regenerate auth token + subdomain + secret
    if (path === "/api/rotate-credentials" && req.method === "POST") {
      const { rotateToken } = await import("./auth");
      const { configSet, tunnelConfig: getTunnelConfig, reloadConfig } = await import("./config");
      const { generateSubdomain, generateSecret } = await import("./subdomain");
      const { deregisterGrove } = await import("./registry");

      // Rotate the auth token
      const newToken = rotateToken();

      const tc = getTunnelConfig();
      let newSubdomain: string | null = null;

      // Deregister old subdomain from Worker, generate new ones
      if (tc.domain && tc.subdomain && tc.secret) {
        try {
          await deregisterGrove({
            registryUrl: `https://${tc.domain}`,
            subdomain: tc.subdomain,
            secret: tc.secret,
          });
        } catch {}

        newSubdomain = generateSubdomain();
        const newSecret = generateSecret();
        configSet("tunnel.subdomain", newSubdomain);
        configSet("tunnel.secret", newSecret);
        reloadConfig();
      }

      db.addEvent(null, null, "credentials_rotated", "Auth token and tunnel credentials rotated via GUI");

      return json({
        ok: true,
        message: "Credentials rotated. Grove will restart to apply new tunnel URL.",
        token: newToken,
        subdomain: newSubdomain,
      });
    }
```

- [ ] **Step 2: Verify build succeeds**

Run: `bun build src/broker/server.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: rotate-credentials deregisters old subdomain from grove.cloud"
```

---

### Task 11: Update grove.yaml config and example

**Files:**
- Modify: `~/.grove/grove.yaml` (user config)
- Modify: `grove.yaml.example`

- [ ] **Step 1: Update grove.yaml — remove name, keep subdomain**

Edit `~/.grove/grove.yaml` tunnel section to:

```yaml
tunnel:
  provider: cloudflare
  auth: token
  domain: grove.cloud
  subdomain: juniper-ridge-dtcw
```

Remove `name: grove` (no longer used). The `secret` will be auto-generated on next startup.

- [ ] **Step 2: Update grove.yaml.example**

Replace the tunnel section in `grove.yaml.example`:

```yaml
# Tunnel configuration (remote access)
tunnel:
  provider: cloudflare  # Free quick tunnels, no account needed
  auth: token           # Random token for security
  # For a stable vanity URL on grove.cloud (free, no Cloudflare account needed):
  # domain: grove.cloud
  # subdomain and secret are auto-generated on first start
```

- [ ] **Step 3: Commit**

```bash
git add grove.yaml.example
git commit -m "docs: update tunnel config example for grove.cloud Worker proxy"
```

---

### Task 12: Clean up old named-tunnel infrastructure

**Files:**
- Delete: `~/.grove/cloudflared.yml` (generated config)

- [ ] **Step 1: Delete the generated cloudflared config**

Run: `rm -f ~/.grove/cloudflared.yml`

- [ ] **Step 2: Delete the named tunnel from Cloudflare**

Run: `cloudflared tunnel delete grove`
Expected: Tunnel deleted (or confirm if connections need to be cleaned up first: `cloudflared tunnel cleanup grove && cloudflared tunnel delete grove`).

- [ ] **Step 3: Delete the stale CNAME on pai.com**

In the Cloudflare dashboard for `pai.com`, delete the `grove.cloud` CNAME record that was accidentally created (the one pointing to the old tunnel UUID at `grove.cloud.pai.com`).

- [ ] **Step 4: Build and test end-to-end**

Run:
```bash
bun run build
grove down
grove up
```

Expected output:
```
  ✓ Broker started (PID XXXXX)
  ✓ Orchestrator spawned in tmux:grove
  ✓ Tunnel active
  ✓ Registered on grove.cloud

  Local:   http://localhost:49152
  Tunnel:  https://random-words.trycloudflare.com
  Remote:  https://juniper-ridge-dtcw.grove.cloud?token=...
```

Verify in browser:
- `https://juniper-ridge-dtcw.grove.cloud?token=...` loads the Grove GUI.
- WebSocket connects and shows live data.
- `https://grove.cloud` shows the landing page.

- [ ] **Step 5: Commit final cleanup**

```bash
git add -A
git commit -m "chore: clean up named-tunnel artifacts"
```
