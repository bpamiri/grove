# Grove Cloud Adoption Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the grove.cloud Cloudflare Worker into its own repo, add a GitHub search scraper that counts Grove-delivered PRs, and expose a Shields.io badge endpoint.

**Architecture:** A single Cloudflare Worker handles three responsibilities — subdomain tunnel proxy (existing), landing page (enhanced), and stats scraper (new). A cron trigger runs every 6 hours, queries GitHub Search API for PRs with Grove signatures, and caches counts in Cloudflare KV. Badge requests read from KV with zero GitHub API calls.

**Tech Stack:** Cloudflare Workers, Cloudflare KV, GitHub Search API, TypeScript, Wrangler CLI, Shields.io endpoint protocol

---

## File Structure — `grove-cloud` repo

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Worker entry: routes requests to proxy, landing, or stats handlers; runs cron |
| `src/proxy.ts` | Subdomain tunnel proxy (extracted from existing `index.ts`) |
| `src/landing.ts` | Landing page HTML with badge |
| `src/stats.ts` | GitHub search scraper + `/api/stats` + `/api/stats/badge` endpoints |
| `wrangler.toml` | Worker config, KV bindings, cron trigger |
| `package.json` | Dependencies (wrangler, @cloudflare/workers-types) |
| `tsconfig.json` | TypeScript config |
| `.github/workflows/deploy.yml` | CI/CD: deploy on push to main |
| `CLAUDE.md` | Repo instructions for Claude Code |
| `tests/stats.test.ts` | Unit tests for scraper logic and badge formatting |
| `tests/proxy.test.ts` | Unit tests for proxy routing |
| `tests/index.test.ts` | Integration test for request routing |

## File Structure — changes in `grove` repo

| File | Change |
|------|--------|
| `src/merge/manager.ts:90` | `"Created by"` → `"Delivered by"` |
| `src/broker/github-sync.ts:14` | `"Created by"` → `"Delivered by"` |
| `worker/` | Delete entire directory |

---

### Task 1: Create the `grove-cloud` repo on GitHub

This task creates the empty repo and initializes it with the basic project scaffolding.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `CLAUDE.md`
- Create: `.gitignore`

- [ ] **Step 1: Create the repo on GitHub**

```bash
gh repo create bpamiri/grove-cloud --public --clone --description "Cloudflare Worker powering grove.cloud — tunnel proxy, landing page, adoption metrics"
cd ~/GitHub/bpamiri/grove-cloud
```

- [ ] **Step 2: Create package.json**

Create `package.json`:

```json
{
  "name": "grove-cloud",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "@cloudflare/vitest-pool-workers": "^0.8",
    "vitest": "^3",
    "wrangler": "^4"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `tsconfig.json`:

```json
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
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

Create `.gitignore`:

```
node_modules/
dist/
.wrangler/
.dev.vars
```

- [ ] **Step 5: Create CLAUDE.md**

Create `CLAUDE.md`:

```markdown
# grove-cloud

Cloudflare Worker powering grove.cloud.

## What This Is

Three responsibilities in one Worker:
1. **Tunnel proxy** — routes `*.grove.cloud` subdomains to registered Grove instances
2. **Landing page** — serves the grove.cloud homepage
3. **Adoption metrics** — scrapes GitHub for Grove-delivered PRs, exposes a Shields.io badge

## Commands

- `bun install` — install dependencies
- `bun run dev` — local dev server (wrangler dev)
- `bun run test` — run tests
- `bun run deploy` — deploy to Cloudflare

## Architecture

- `src/index.ts` — request router + cron handler
- `src/proxy.ts` — subdomain proxy logic
- `src/landing.ts` — landing page HTML
- `src/stats.ts` — GitHub search scraper + badge endpoint

## KV Namespaces

- `GROVE_ROUTES` — tunnel route registrations (subdomain → target URL)
- `GROVE_STATS` — cached adoption metrics from GitHub search

## Secrets

- `GITHUB_TOKEN` — fine-grained PAT for GitHub search API (no permissions needed, just auth for rate limits)
```

- [ ] **Step 6: Install dependencies**

```bash
bun install
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: initialize grove-cloud repo with scaffolding"
```

---

### Task 2: Extract proxy logic into `src/proxy.ts`

Extract the existing tunnel proxy code from the Grove worker into its own module.

**Files:**
- Create: `src/proxy.ts`

- [ ] **Step 1: Write failing test for proxy**

Create `tests/proxy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractSubdomain, handleRegister, handleDeregister } from "../src/proxy";

describe("extractSubdomain", () => {
  it("extracts subdomain from grove.cloud host", () => {
    expect(extractSubdomain("my-grove.grove.cloud")).toBe("my-grove");
  });

  it("returns null for bare domain", () => {
    expect(extractSubdomain("grove.cloud")).toBeNull();
  });

  it("returns null for unrelated host", () => {
    expect(extractSubdomain("example.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test
```

Expected: FAIL — `../src/proxy` does not exist.

- [ ] **Step 3: Implement proxy module**

Create `src/proxy.ts`:

```typescript
// src/proxy.ts — Subdomain tunnel proxy for *.grove.cloud

export interface ProxyEnv {
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

export function extractSubdomain(host: string): string | null {
  const match = host.match(/^([a-z0-9-]+)\.grove\.cloud$/);
  return match ? match[1] : null;
}

export async function handleRegister(request: Request, env: ProxyEnv): Promise<Response> {
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

export async function handleDeregister(request: Request, env: ProxyEnv): Promise<Response> {
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
    return json({ ok: true });
  }
  if (existing.secret !== secret) {
    return json({ error: "Forbidden: secret mismatch" }, 403);
  }

  await env.GROVE_ROUTES.delete(subdomain);
  return json({ ok: true });
}

export async function handleProxy(
  request: Request,
  subdomain: string,
  env: ProxyEnv,
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

  const targetUrl = new URL(request.url);
  const target = new URL(record.target);
  targetUrl.hostname = target.hostname;
  targetUrl.port = target.port;
  targetUrl.protocol = target.protocol;

  const proxyReq = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });

  return fetch(proxyReq);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test
```

Expected: PASS — all 3 `extractSubdomain` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts tests/proxy.test.ts
git commit -m "feat: extract proxy module from existing worker"
```

---

### Task 3: Implement stats scraper and badge endpoint

**Files:**
- Create: `src/stats.ts`
- Create: `tests/stats.test.ts`

- [ ] **Step 1: Write failing tests for stats**

Create `tests/stats.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatBadge, formatStats, parseSearchCount } from "../src/stats";

describe("parseSearchCount", () => {
  it("extracts total_count from GitHub search response", () => {
    const response = { total_count: 47, incomplete_results: false, items: [] };
    expect(parseSearchCount(response)).toBe(47);
  });

  it("returns 0 for malformed response", () => {
    expect(parseSearchCount({})).toBe(0);
    expect(parseSearchCount(null)).toBe(0);
  });
});

describe("formatBadge", () => {
  it("returns Shields.io endpoint schema", () => {
    const badge = formatBadge(47);
    expect(badge).toEqual({
      schemaVersion: 1,
      label: "PRs delivered",
      message: "47",
      color: "34d399",
    });
  });

  it("formats large numbers with commas", () => {
    const badge = formatBadge(1234);
    expect(badge.message).toBe("1,234");
  });
});

describe("formatStats", () => {
  it("returns public stats shape", () => {
    const stats = formatStats({
      total_prs: 47,
      legacy_prs: 12,
      unique_repos: 8,
      updated_at: "2026-03-31T12:00:00Z",
    });
    expect(stats).toEqual({
      prs: 47,
      repos: 8,
      updated_at: "2026-03-31T12:00:00Z",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun run test
```

Expected: FAIL — `../src/stats` does not exist.

- [ ] **Step 3: Implement stats module**

Create `src/stats.ts`:

```typescript
// src/stats.ts — GitHub search scraper + badge endpoint for adoption metrics

export interface StatsEnv {
  GROVE_STATS: KVNamespace;
  GITHUB_TOKEN: string;
}

export interface StoredStats {
  total_prs: number;
  legacy_prs: number;
  unique_repos: number;
  updated_at: string;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{ repository_url: string }>;
}

export function parseSearchCount(response: unknown): number {
  if (response && typeof response === "object" && "total_count" in response) {
    return (response as GitHubSearchResponse).total_count;
  }
  return 0;
}

export function formatBadge(prCount: number) {
  return {
    schemaVersion: 1,
    label: "PRs delivered",
    message: prCount.toLocaleString("en-US"),
    color: "34d399",
  };
}

export function formatStats(stored: StoredStats) {
  return {
    prs: stored.total_prs,
    repos: stored.unique_repos,
    updated_at: stored.updated_at,
  };
}

async function searchGitHub(query: string, token: string): Promise<GitHubSearchResponse> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "grove-cloud-worker",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub search failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function countUniqueRepos(query: string, token: string): Promise<number> {
  // Fetch up to 100 results to count unique repos
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "grove-cloud-worker",
    },
  });
  if (!res.ok) return 0;
  const data: GitHubSearchResponse = await res.json();
  const repos = new Set(data.items.map((item) => item.repository_url));
  return repos.size;
}

export async function scrapeStats(env: StatsEnv): Promise<StoredStats> {
  const [delivered, legacy] = await Promise.all([
    searchGitHub('"Delivered by Grove" is:pr', env.GITHUB_TOKEN),
    searchGitHub('"Created by Grove" is:pr', env.GITHUB_TOKEN),
  ]);

  const totalPrs = parseSearchCount(delivered) + parseSearchCount(legacy);

  // Count unique repos from both queries
  const [deliveredRepos, legacyRepos] = await Promise.all([
    countUniqueRepos('"Delivered by Grove" is:pr', env.GITHUB_TOKEN),
    countUniqueRepos('"Created by Grove" is:pr', env.GITHUB_TOKEN),
  ]);

  // Merge repo counts (approximate — repos may appear in both)
  const uniqueRepos = Math.max(deliveredRepos, legacyRepos);

  const stats: StoredStats = {
    total_prs: totalPrs,
    legacy_prs: parseSearchCount(legacy),
    unique_repos: uniqueRepos,
    updated_at: new Date().toISOString(),
  };

  await env.GROVE_STATS.put("stats", JSON.stringify(stats));
  return stats;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });

export async function handleStats(env: StatsEnv): Promise<Response> {
  const stored = await env.GROVE_STATS.get<StoredStats>("stats", "json");
  if (!stored) {
    return json({ prs: 0, repos: 0, updated_at: null });
  }
  return json(formatStats(stored));
}

export async function handleBadge(env: StatsEnv): Promise<Response> {
  const stored = await env.GROVE_STATS.get<StoredStats>("stats", "json");
  const count = stored?.total_prs ?? 0;
  return json(formatBadge(count));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test
```

Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stats.ts tests/stats.test.ts
git commit -m "feat: add GitHub search scraper and badge endpoint"
```

---

### Task 4: Implement landing page

**Files:**
- Create: `src/landing.ts`

- [ ] **Step 1: Write failing test for landing page**

Create `tests/landing.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { landingPage } from "../src/landing";

describe("landingPage", () => {
  it("returns HTML with Content-Type header", () => {
    const response = landingPage();
    expect(response.headers.get("Content-Type")).toBe("text/html");
  });

  it("includes the badge image", async () => {
    const response = landingPage();
    const html = await response.text();
    expect(html).toContain("grove.cloud/api/stats/badge");
  });

  it("includes GitHub link", async () => {
    const response = landingPage();
    const html = await response.text();
    expect(html).toContain("github.com/bpamiri/grove");
  });

  it("includes the tagline", async () => {
    const response = landingPage();
    const html = await response.text();
    expect(html).toContain("Open source AI orchestrator");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun run test
```

Expected: FAIL — `../src/landing` does not exist.

- [ ] **Step 3: Implement landing page**

Create `src/landing.ts`:

```typescript
// src/landing.ts — grove.cloud landing page

export function landingPage(): Response {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grove — Open source AI orchestrator</title>
<style>
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #09090b;
    color: #a1a1aa;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
  }
  .c {
    text-align: center;
  }
  h1 {
    color: #34d399;
    font-size: 2rem;
    margin-bottom: 0.25rem;
  }
  .tagline {
    font-size: 1.1rem;
    margin-bottom: 1.5rem;
  }
  .badge {
    margin-bottom: 1.5rem;
  }
  a {
    color: #34d399;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
</style>
</head>
<body>
<div class="c">
  <h1>Grove</h1>
  <p class="tagline">Open source AI orchestrator</p>
  <div class="badge">
    <img src="https://img.shields.io/endpoint?url=https://grove.cloud/api/stats/badge&style=flat-square" alt="PRs delivered" />
  </div>
  <p><a href="https://github.com/bpamiri/grove">github.com/bpamiri/grove</a></p>
</div>
</body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test
```

Expected: PASS — all 4 landing page tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/landing.ts tests/landing.test.ts
git commit -m "feat: add landing page with adoption badge"
```

---

### Task 5: Wire up the router (`src/index.ts`)

Combine proxy, landing, and stats into the main worker entry point.

**Files:**
- Create: `src/index.ts`
- Create: `tests/index.test.ts`

- [ ] **Step 1: Write failing test for router**

Create `tests/index.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Test the routing logic by examining the module exports
// Full integration tests require wrangler's miniflare environment;
// here we verify the module shape and pure routing helpers.

describe("worker module", () => {
  it("exports a default with fetch and scheduled handlers", async () => {
    const mod = await import("../src/index");
    expect(mod.default).toHaveProperty("fetch");
    expect(mod.default).toHaveProperty("scheduled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test
```

Expected: FAIL — `../src/index` does not exist.

- [ ] **Step 3: Implement the router**

Create `src/index.ts`:

```typescript
// src/index.ts — grove.cloud Worker entry point

import { extractSubdomain, handleRegister, handleDeregister, handleProxy, type ProxyEnv } from "./proxy";
import { landingPage } from "./landing";
import { handleStats, handleBadge, scrapeStats, type StatsEnv } from "./stats";

export interface Env extends ProxyEnv, StatsEnv {}

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

    // Stats endpoints (bare domain only)
    if (url.pathname === "/api/stats/badge") {
      return handleBadge(env);
    }
    if (url.pathname === "/api/stats") {
      return handleStats(env);
    }

    // Subdomain → proxy
    const subdomain = extractSubdomain(host);
    if (subdomain) {
      return handleProxy(request, subdomain, env);
    }

    // Bare domain → landing page
    return landingPage();
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await scrapeStats(env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test
```

Expected: PASS — module exports `fetch` and `scheduled`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat: wire up router with proxy, landing, and stats"
```

---

### Task 6: Configure Wrangler and CI/CD

**Files:**
- Create: `wrangler.toml`
- Create: `.github/workflows/deploy.yml`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create wrangler.toml**

Create `wrangler.toml`:

```toml
name = "grove-cloud"
main = "src/index.ts"
compatibility_date = "2026-03-28"

routes = [
  { pattern = "grove.cloud/*", zone_name = "grove.cloud" },
  { pattern = "*.grove.cloud/*", zone_name = "grove.cloud" }
]

# Cron trigger: scrape GitHub search every 6 hours
[triggers]
crons = ["0 */6 * * *"]

# Existing KV for tunnel proxy routes
[[kv_namespaces]]
binding = "GROVE_ROUTES"
id = "f5178e934c1c4bd2b9bf3ed02d614039"

# New KV for adoption stats cache
[[kv_namespaces]]
binding = "GROVE_STATS"
id = "PLACEHOLDER_REPLACE_AFTER_KV_CREATE"
```

Note: The `GROVE_STATS` KV ID must be replaced after creating the namespace. See Step 3.

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 3: Create KV namespace and update wrangler.toml**

```bash
wrangler kv namespace create GROVE_STATS
```

Copy the output `id` and replace `PLACEHOLDER_REPLACE_AFTER_KV_CREATE` in `wrangler.toml`.

- [ ] **Step 4: Set the GitHub token secret**

```bash
wrangler secret put GITHUB_TOKEN
```

Paste a fine-grained GitHub PAT (no permissions needed — public search only requires auth for higher rate limits).

- [ ] **Step 5: Create deploy workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - run: bun install

      - run: bun run test

      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml vitest.config.ts .github/workflows/deploy.yml
git commit -m "chore: add wrangler config, vitest, and deploy workflow"
```

---

### Task 7: Deploy and verify

- [ ] **Step 1: Run all tests locally**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 2: Test locally with wrangler dev**

```bash
bun run dev
```

Verify in another terminal:
```bash
# Landing page
curl -s http://localhost:8787/ | grep "Grove"

# Stats endpoint (will return zeros — no KV data yet)
curl -s http://localhost:8787/api/stats

# Badge endpoint
curl -s http://localhost:8787/api/stats/badge

# Health check
curl -s http://localhost:8787/_grove/health
```

- [ ] **Step 3: Deploy to Cloudflare**

```bash
bun run deploy
```

- [ ] **Step 4: Verify production**

```bash
curl -s https://grove.cloud/ | grep "Grove"
curl -s https://grove.cloud/api/stats
curl -s https://grove.cloud/api/stats/badge
curl -s https://grove.cloud/_grove/health
```

- [ ] **Step 5: Trigger the cron manually to seed initial stats**

```bash
wrangler dev --test-scheduled
```

Then in another terminal:
```bash
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"
```

Verify stats are populated:
```bash
curl -s https://grove.cloud/api/stats
```

Expected: `{"prs":N,"repos":N,"updated_at":"..."}`

- [ ] **Step 6: Commit any fixes, then push**

```bash
git push -u origin main
```

---

### Task 8: Update Grove repo — signature and cleanup

Switch back to the `grove` repo.

**Files:**
- Modify: `src/merge/manager.ts:90`
- Modify: `src/broker/github-sync.ts:14`
- Delete: `worker/` directory

- [ ] **Step 1: Update signature in merge manager**

In `src/merge/manager.ts` line 90, change:

```typescript
// Old
"*Created by [Grove](https://grove.cloud)*",

// New
"*Delivered by [Grove](https://grove.cloud)*",
```

- [ ] **Step 2: Update signature in github-sync**

In `src/broker/github-sync.ts` line 14, change:

```typescript
// Old
"*Created by [Grove](https://grove.cloud)*",

// New
"*Delivered by [Grove](https://grove.cloud)*",
```

- [ ] **Step 3: Run Grove tests to make sure nothing breaks**

```bash
bun test
```

Expected: all existing tests pass. If any tests assert on the "Created by" string, update them to "Delivered by".

- [ ] **Step 4: Commit signature change**

```bash
git add src/merge/manager.ts src/broker/github-sync.ts
git commit -m "feat: change PR signature to 'Delivered by Grove'"
```

- [ ] **Step 5: Remove the worker directory**

```bash
rm -rf worker/
```

- [ ] **Step 6: Commit worker removal**

```bash
git add -A
git commit -m "chore: remove worker/ directory (moved to bpamiri/grove-cloud)"
```

---

### Task 9: Add `grove-cloud` as a Grove tree

- [ ] **Step 1: Register the new repo as a tree in Grove**

```bash
grove trees add --name grove-cloud --path ~/GitHub/bpamiri/grove-cloud --github bpamiri/grove-cloud
```

- [ ] **Step 2: Verify**

```bash
grove trees
```

Expected: `grove-cloud` appears in the tree list.

---

## Unresolved Questions

1. **CLOUDFLARE_API_TOKEN** — Does the `bpamiri` GitHub org already have this secret for CI/CD, or does it need to be created?
2. **KV namespace ID** — Task 6 Step 3 requires creating `GROVE_STATS` via `wrangler kv namespace create`. The ID is only known after creation.
3. **Unique repo count accuracy** — The `countUniqueRepos` function fetches up to 100 items. If Grove-delivered PRs span >100 PRs, the repo count will be approximate. Acceptable for now.
