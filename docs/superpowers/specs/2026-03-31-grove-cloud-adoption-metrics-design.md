# Design Spec: Grove Cloud Adoption Metrics

**Date:** 2026-03-31
**Status:** Draft
**Issue:** N/A

## Problem

Grove stamps every PR it creates with a footer signature. There is no way to measure how widely Grove is being adopted — whether other people beyond the author are using it to deliver PRs. Anthropic tracks what percentage of GitHub commits involve Claude; Grove needs an analogous signal, even at a smaller scale.

## Decision: Signature Wording

Grove is an orchestrator, not the agent that writes code. The agent (Claude today, potentially others in the future) does the implementation work; Grove coordinates the pipeline, runs quality gates, creates the PR, watches CI, and merges.

**New signature:** `*Delivered by [Grove](https://grove.cloud)*`

- "Delivered by" captures Grove's role — it got the work across the finish line
- The agent retains its own credit via `Co-Authored-By` commit trailers
- Future-proof: the signature is agent-agnostic

**Legacy signature:** `*Created by [Grove](https://grove.cloud)*` — existing PRs keep this; the scraper searches for both.

## Solution: `grove-cloud` Repo + Cloudflare Worker

### New Repository

Extract the existing `worker/` directory from `bpamiri/grove` into a new repo `bpamiri/grove-cloud`. This gives the grove.cloud infrastructure its own deployment lifecycle and CI/CD.

**Repo structure:**

```
grove-cloud/
├── src/
│   ├── index.ts          # Router: proxy + landing + stats
│   ├── landing.ts        # Landing page HTML
│   ├── proxy.ts          # Subdomain proxy logic (existing)
│   └── stats.ts          # GitHub search scraper + badge endpoint
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .github/workflows/
│   └── deploy.yml        # wrangler deploy on push to main
└── CLAUDE.md
```

### Stats Scraper

A Cloudflare Worker cron trigger (every 6 hours) that queries GitHub Search API:

**Search queries:**
- `"Delivered by Grove" is:pr` — new signature
- `"Created by Grove" is:pr` — legacy signature

**Stored in Cloudflare KV** (`GROVE_STATS` namespace):

```json
{
  "total_prs": 47,
  "legacy_prs": 12,
  "unique_repos": 8,   // repos with at least one Grove PR (any state)
  "updated_at": "2026-03-31T12:00:00Z"
}
```

**Authentication:** A fine-grained GitHub PAT with no permissions (public search only needs auth for higher rate limits). Stored as a Cloudflare Worker secret (`GITHUB_TOKEN`).

**Rate limit safety:** 2 queries every 6 hours — well within GitHub's 30 req/min authenticated limit. KV serves all badge requests with zero GitHub API calls.

### API Endpoints

**`GET grove.cloud/api/stats`**

```json
{
  "prs": 47,
  "repos": 8,
  "updated_at": "2026-03-31T12:00:00Z"
}
```

**`GET grove.cloud/api/stats/badge`** (Shields.io endpoint format)

```json
{
  "schemaVersion": 1,
  "label": "PRs delivered",
  "message": "47",
  "color": "34d399"
}
```

Badge color uses Grove's green (`#34d399`).

### Badge Embed

```markdown
![PRs delivered](https://img.shields.io/endpoint?url=https://grove.cloud/api/stats/badge&style=flat-square)
```

Displayed on the grove.cloud landing page and the Grove GitHub README.

### Landing Page

Keep the current minimal aesthetic (dark background, Grove green). Enhancements:

- Live badge showing PR count
- Tagline: "Open source AI orchestrator"
- Link to GitHub repo

No framework, no build step. Static HTML served from `landing.ts`.

### Existing Functionality Preserved

The subdomain proxy (`*.grove.cloud` → tunnel routing) moves unchanged:

- `/_grove/register` — POST to register a subdomain route
- `/_grove/health` — health check
- `*.grove.cloud` — reverse proxy to registered tunnel targets
- KV namespace `GROVE_ROUTES` — existing route storage (unchanged)

## Migration Plan

1. Create `bpamiri/grove-cloud` repo with extracted worker code + new stats features
2. Deploy via `wrangler deploy` — verify grove.cloud works
3. Update Grove repo: change `"Created by"` → `"Delivered by"` in `src/merge/manager.ts` and `src/broker/github-sync.ts`
4. Remove `worker/` directory from Grove repo
5. Add `grove-cloud` as a tree in Grove config

**Backward compatibility:** Scraper searches for both signatures — no existing PRs are lost.

## Not In Scope

- Commit counting (agents handle their own `Co-Authored-By`)
- Historical trending / time series (can add later with daily KV snapshots)
- Per-org or per-user breakdowns
- Authentication on the stats endpoints (public data from public GitHub search)
