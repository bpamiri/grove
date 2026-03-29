# grove.cloud Worker Proxy

**Date:** 2026-03-28
**Status:** Approved

## Problem

Grove uses Cloudflare quick tunnels for remote access. Quick tunnels generate random `trycloudflare.com` URLs that change on every restart, breaking bookmarks and remote sessions. Named tunnels with custom domains solve stability but require per-user Cloudflare account setup (zone auth, tunnel creation, DNS routing) — too much friction for an open source tool.

## Solution

A Cloudflare Worker on `grove.cloud` acts as a shared reverse proxy. Any grove instance can register its ephemeral quick-tunnel URL under a stable vanity subdomain (e.g., `cedar-ridge-7kx2.grove.cloud`). The Worker proxies all traffic — including WebSockets — to the current quick-tunnel URL. Users get stable URLs with zero Cloudflare account setup.

## Architecture

```
grove up
  ├─ starts quick tunnel → https://random.trycloudflare.com
  ├─ registers with Worker: POST grove.cloud/_grove/register
  │    { subdomain, target, secret }
  └─ starts heartbeat (every 5 min)

Browser → cedar-ridge-7kx2.grove.cloud
  ├─ Cloudflare edge → Worker
  ├─ Worker reads KV: cedar-ridge-7kx2 → { target, secret, expires }
  └─ Worker proxies request to https://random.trycloudflare.com
       (including WebSocket upgrade)
```

### Components

1. **Cloudflare Worker + KV** (`grove.cloud` zone) — reverse proxy with subdomain-based routing. Lives in `worker/` directory. Deployed via `wrangler`.
2. **Registration client** (`src/broker/registry.ts`) — on startup, registers subdomain→target with the Worker. Sends heartbeats to keep mapping alive.
3. **Simplified tunnel module** — always uses quick tunnels. Named-tunnel code is removed entirely. The `domain` config field means "register with this domain's Worker."

## Worker Design

### Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/_grove/register` | Register or update subdomain→target mapping |
| `DELETE` | `/_grove/register` | Deregister a subdomain |
| `GET` | `/_grove/health` | Worker health check |
| `*` | everything else | Proxy to target based on subdomain |

### KV Schema

Namespace: `GROVE_ROUTES`. Key: subdomain string.

```json
{
  "target": "https://random-words.trycloudflare.com",
  "secret": "a1b2c3d4e5f6...",
  "expires": 1711648000000
}
```

### Registration Flow

1. Grove sends `POST /_grove/register` with `{ subdomain, target, secret }`.
2. Worker checks KV:
   - If subdomain is new: store the mapping.
   - If subdomain exists: `secret` must match (ownership check). Reject with 403 if mismatch.
3. Set `expires = now + 30 minutes`.
4. Return `{ ok: true, url: "https://<subdomain>.grove.cloud" }`.

### Heartbeat

Grove sends the same `POST /_grove/register` every 5 minutes with the current target URL. This:
- Refreshes `expires` (keeps mapping alive)
- Updates `target` if the quick tunnel URL changed (restart case)

### Proxy Flow

1. Extract subdomain from `Host` header (`cedar-ridge-7kx2` from `cedar-ridge-7kx2.grove.cloud`).
2. If bare domain (`grove.cloud`, no subdomain): return a simple landing page ("Grove — open source AI orchestrator" with link to repo).
3. Look up subdomain in KV.
4. If not found or expired: return 404 page ("This grove is offline").
5. Rewrite request: replace origin with `target`, forward all headers.
6. For WebSocket upgrades: pass through via `fetch()` (Workers support this natively).

### Credential Rotation

The existing `POST /api/rotate-credentials` on the grove broker:
1. Generates new subdomain + new secret.
2. Calls `DELETE /_grove/register` with old subdomain + old secret (cleanup).
3. Registers new subdomain with the Worker.
4. Rotates the auth token.
5. Restarts grove.

Old URL goes dead immediately.

## Config Changes

### grove.yaml tunnel section

```yaml
tunnel:
  provider: cloudflare
  auth: token
  # Optional: register with grove.cloud for a stable vanity URL
  domain: grove.cloud
  subdomain: cedar-ridge-7kx2   # auto-generated on first start
  secret: a1b2c3d4e5f6...       # auto-generated, proves ownership
```

- `domain` absent: quick tunnel only, trycloudflare URL, no registration.
- `domain: grove.cloud`: quick tunnel + register with Worker for vanity URL.
- `name` field: removed (named tunnels eliminated).
- `secret` field: new, auto-generated on first start, persisted. Proves subdomain ownership.

### TunnelConfig type

```typescript
export interface TunnelConfig {
  provider: "cloudflare" | "bore" | "ngrok";
  auth: "token" | "none";
  domain?: string;
  subdomain?: string;
  secret?: string;
}
```

## Broker Startup Sequence

1. Start quick tunnel → get `https://random.trycloudflare.com`.
2. If `domain` is set:
   a. Generate `subdomain` + `secret` if not already in config (first run).
   b. `POST https://grove.cloud/_grove/register` with `{ subdomain, target, secret }`.
   c. Set `remoteUrl` to `https://<subdomain>.grove.cloud` (not the trycloudflare URL).
3. Start heartbeat interval (every 5 min, same POST).

## Broker Shutdown

`DELETE /_grove/register` with `{ subdomain, secret }` — optional cleanup so the route doesn't linger until TTL expiry.

## CLI Output

```
  Local:   http://localhost:49152
  Tunnel:  https://random-words.trycloudflare.com
  Remote:  https://cedar-ridge-7kx2.grove.cloud?token=9wysi...
```

Shows both the raw tunnel (for debugging) and the vanity URL (for sharing).

## Files Changed

### New

- `worker/wrangler.toml` — Worker config (KV binding, routes)
- `worker/src/index.ts` — Worker: proxy + registration endpoints (~120 lines)
- `src/broker/registry.ts` — registration client + heartbeat

### Modified

- `src/tunnel/cloudflare.ts` — remove named-tunnel code, quick-tunnels only
- `src/broker/index.ts` — call registry after tunnel start, start heartbeat, show both URLs
- `src/broker/subdomain.ts` — add `generateSecret()`
- `src/shared/types.ts` — TunnelConfig: remove `name`, add `secret`
- `src/broker/server.ts` — rotate-credentials endpoint: deregister old, register new
- `src/cli/commands/up.ts` — show tunnel URL + remote URL separately

### Deleted

- Named tunnel config generation (`~/.grove/cloudflared.yml`)
- `findCredentialsFile()` and related named-tunnel methods
- The `grove` named tunnel on Cloudflare (cleanup)

## One-Time Infrastructure Setup

On Peter's Cloudflare account for the `grove.cloud` zone:

1. Create Worker + KV namespace via `wrangler`.
2. DNS: `*.grove.cloud` route → Worker (update existing wildcard CNAME to Worker route).
3. Deploy with `wrangler deploy`.

## Security

- **Subdomain entropy:** 22 trees x 22 features x 36^4 suffix = ~800M combinations. Unguessable.
- **Ownership:** Registration requires a `secret` that must match on updates. Prevents hijacking.
- **TTL expiry:** Mappings expire after 30 min of no heartbeat. Dead groves don't linger.
- **Auth:** Grove's existing token auth protects the API/WebSocket layer. The Worker is a transparent proxy — it doesn't add or remove auth.
- **Rotation:** Both subdomain and secret can be rotated atomically, invalidating the old URL and ownership proof.
