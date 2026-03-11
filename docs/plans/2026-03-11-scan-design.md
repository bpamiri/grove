# Auto-Discover Work (`grove scan`) Design

**Goal:** Automatically discover actionable work from configured repos — code markers, toolchain signals, and AI-powered analysis — and feed findings into the task pipeline.

**Problem:** Tasks currently come from manual entry (`grove add`) or GitHub issues (`grove sync`). TODOs, FIXMEs, failing tests, outdated deps, and code smells sit undiscovered until someone notices them. `grove scan` closes this gap.

## Command Interface

**`grove scan [--repo NAME] [--deep[=CATEGORIES]] [--apply] [--interactive] [--dry-run] [--limit N]`**

| Flag | Purpose |
|------|---------|
| `--repo NAME` | Scan a specific repo only (default: all configured repos) |
| `--dry-run` | Preview findings without creating tasks **(default)** |
| `--apply` | Create tasks directly as `ingested` |
| `--interactive` | Triage findings one-by-one (accept/skip/edit) |
| `--deep[=CATEGORIES]` | AI analysis via Claude. Categories: `smells`, `tests`, `security`. Default: `smells,tests` |
| `--limit N` | Cap findings per repo (default: 50) |
| No flags | Dry-run with code markers + repo signals only |

### Three Scan Tiers

1. **Markers** (always runs) — grep for TODO, FIXME, HACK, DEPRECATED, XXX in source files
2. **Signals** (always runs) — failing tests, outdated deps, lint warnings (detected per-repo toolchain)
3. **Deep** (opt-in `--deep`) — Claude analyzes source files for smells, test gaps, security issues

### Dedup

Each finding gets a `source_ref` like `scan:wheels:src/auth.ts:45:TODO` or `scan:wheels:deep:smells:auth-complexity`. Tasks with matching `source_ref` are skipped. `source_type` = `"scan"` (already in `SourceType` enum).

## Scan Logic Per Tier

### Markers (grep-based, fast)

Scan all source files in repo for regex patterns:
- `TODO`, `FIXME`, `HACK`, `XXX`, `DEPRECATED` (case-insensitive)
- Skip `node_modules/`, `.git/`, `vendor/`, `dist/`, `build/`, binary files
- Extract: file, line number, marker type, surrounding text as description
- Source ref: `scan:{repo}:{file}:{line}:{marker}`

### Signals (toolchain detection)

Auto-detect repo toolchain and run checks:

| Signal | Detection | Command |
|--------|-----------|---------|
| Failing tests | `package.json` → `bun test` / `npm test`; `pyproject.toml` → `pytest`; `Cargo.toml` → `cargo test` | Run with dry-run or equivalent, parse exit code + output |
| Outdated deps | `package.json` → `npm outdated --json`; `pyproject.toml` → `pip list --outdated --format=json` | Parse JSON output for major version bumps only |
| Lint warnings | `.eslintrc*` → `npx eslint --format=json`; `ruff.toml` → `ruff check --output-format=json` | Parse structured output |

Each signal creates one task per distinct issue. Source ref: `scan:{repo}:signal:{type}:{identifier}` (e.g., `scan:wheels:signal:outdep:lodash`).

**Timeout:** 30s per command. Skip silently on failure (repo might not have that toolchain).

### Deep (AI analysis, opt-in)

- Read source files (skip generated/vendored), chunk into ~50KB batches
- Send to Claude with a category-specific system prompt:
  - **smells**: "Identify dead code, overly complex functions (>50 lines), missing error handling, inconsistent patterns"
  - **tests**: "Identify modules with no test coverage, functions with untested edge cases, missing integration tests"
  - **security**: "Identify potential vulnerabilities: injection, hardcoded secrets, unsafe deserialization, OWASP top 10"
- Parse structured response (JSON array of findings)
- Source ref: `scan:{repo}:deep:{category}:{file}:{short-hash}`
- Cost guard: show estimated token count before proceeding, require confirmation unless `--apply`

## Output Format

### Dry-run (default — grouped detail)

```
Grove Scan — Dry Run

  wheels (3 findings)
    TODO   src/core/router.ts:142    "refactor route matching logic"
    FIXME  src/lib/cache.ts:88       "handle cache invalidation race"
    OUTDEP lodash 4.17.21 → 5.0.0   major version bump

  pai-man (2 findings)
    HACK   src/api/auth.py:34        "temporary workaround for token refresh"
    DEEP   src/api/orders.py          [smells] complex function (87 lines)

  Total: 5 finding(s) across 2 repo(s)
  Run with --apply to create tasks, or --interactive to triage.
```

### Apply mode — summary

```
Grove Scan — 5 task(s) created
  P-012  pai-man   HACK: temporary workaround for token refresh
  P-013  pai-man   Complex function in orders.py (87 lines)
  W-045  wheels    TODO: refactor route matching logic
  W-046  wheels    FIXME: handle cache invalidation race
  W-047  wheels    Outdated: lodash 4.17.21 → 5.0.0
```

### Interactive mode — per-finding triage

```
[1/5] TODO src/core/router.ts:142
  "refactor route matching logic"
  [a]ccept  [s]kip  [e]dit title  [q]uit
```

## Task Creation Details

- `source_type` = `"scan"`
- `source_ref` = deterministic ref (for dedup)
- `status` = `"ingested"` (flows into normal plan → dispatch pipeline)
- `priority` = 50 (default), except security findings = 30 (higher priority)
- `title` = `"{MARKER}: {description}"` for markers, `"Outdated: {pkg}"` for deps, `"[{category}] {summary}"` for deep
- `description` = full context (surrounding lines, AI reasoning for deep)

## Decisions

- **Dry-run default** — matches `grove gc` safety pattern. Scan can be noisy; preview first.
- **Source-ref dedup** — deterministic, matches `grove sync` pattern. Prevents duplicate tasks across runs.
- **Toolchain auto-detection** — zero config, skip gracefully if not found. No per-repo configuration needed.
- **Deep cost guard** — confirm before spending on AI analysis. Shows estimated token count.
- **Security findings get higher priority (30)** — they're more urgent than TODOs (50).
- **Limit per repo** — prevents noise flood from large repos. Default 50.
- **Three output modes** — dry-run for preview, apply for automation/CI, interactive for first-time triage.
- **Configurable deep categories** — `--deep=smells,tests,security` with `--deep` defaulting to `smells,tests`. Matches `grove gc` configurable-categories pattern.

## Unresolved Questions

- Should `grove scan` respect `.gitignore` for marker scanning, or use its own ignore list?
- Should deep analysis use the local `claude` CLI or the Anthropic API directly?
- Should signal scanning (tests, lint) create one task per failure or one aggregate task per signal type?
