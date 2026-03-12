# Worker Quality Gates Design

**Goal:** Validate worker output before publishing PRs — catch broken tests, missing commits, lint errors, and suspicious diffs before they become draft PRs.

**Problem:** Workers that exit 0 get auto-published regardless of output quality. A worker that produces no commits, breaks tests, or introduces lint errors still gets a PR created and status set to `done`. Quality gates slot between "worker finished" and "publish" to prevent bad PRs.

## Gate Architecture

### New module: `src/lib/gates.ts`

Four gate checks, each a pure function returning a `GateResult`:

```typescript
interface GateResult {
  gate: string;          // "commits" | "tests" | "lint" | "diff_size"
  passed: boolean;
  tier: "hard" | "soft"; // hard = auto-retry, soft = mark for review
  message: string;       // human-readable detail
}

interface GateConfig {
  commits: boolean;
  tests: boolean;
  lint: boolean;
  diff_size: boolean;
  min_diff_lines: number;
  max_diff_lines: number;
  test_timeout: number;
  lint_timeout: number;
}
```

| Gate | Tier | What it checks | Pass condition |
|------|------|----------------|----------------|
| `commits` | hard | `git log main..HEAD --oneline` in worktree | At least 1 commit on branch |
| `tests` | hard | Detect test runner, run it | Exit code 0 (or no runner → auto-pass) |
| `lint` | soft | Detect linter, run it | Exit code 0 (or no linter → auto-pass) |
| `diff_size` | soft | `git diff --stat main..HEAD` | Lines changed within min..max range |

### Orchestrator

```typescript
async function runGates(taskId: string, worktreePath: string, config: GateConfig): Promise<GateResult[]>
```

Runs all enabled gates, returns results array. Caller decides action based on hard vs soft failures.

### Toolchain Detection Reuse

`gates.ts` imports `detectToolchain()` from `scanner.ts` for test runner and linter detection. No duplication.

Output capture: Gate checks capture stdout/stderr (capped at 5KB) for `GateResult.message` and retry prompts.

Timeout: Configurable per gate (`test_timeout`, `lint_timeout`). On timeout, gate fails with clear message.

## Dispatch Integration

**Insertion point:** Between "worker finished" and "set status + publish" in `dispatch.ts`.

### Flow

```
worker exits 0 → run gates → all pass?       → set done → publish PR
                            → hard fail?      → auto-retry (if retries left) or set failed
                            → soft fail only? → set review (no PR) + attach details
```

### Retry Mechanism

When a hard gate fails and `retry_count < max_retries`:
1. Increment `retry_count`
2. Build a fix prompt describing what failed (with captured output)
3. Re-dispatch — reuses existing worktree (no re-creation)
4. Log `gate_retry` event

Both foreground and background dispatch paths use the same `runGates()` function.

### Retry Prompt Format

```
Your previous session completed but failed quality checks:
- tests: FAILED — "3 tests failed: auth.test.ts, router.test.ts, cache.test.ts"

Fix these issues. The worktree still contains your previous work.
Run tests before finishing to confirm they pass.
```

## Configuration

### Global defaults in `grove.yaml`

```yaml
settings:
  quality_gates:
    commits: true          # hard gate
    tests: true            # hard gate
    lint: false            # soft gate — off by default
    diff_size: true        # soft gate
    min_diff_lines: 1      # suspiciously empty
    max_diff_lines: 5000   # suspiciously large
    test_timeout: 60       # seconds
    lint_timeout: 30       # seconds
```

### Per-repo overrides

```yaml
repos:
  wheels:
    org: wheels-dev
    path: ~/GitHub/wheels-dev/wheels
    quality_gates:
      lint: true
      max_diff_lines: 10000
  titan:
    org: paiindustries
    path: ~/GitHub/paiindustries/titan
    quality_gates:
      tests: false         # CFML — no bun/npm test runner
```

### Resolution

Per-repo values override global. Missing keys fall back to global defaults. If no `quality_gates` section exists anywhere, built-in defaults apply (commits + tests + diff_size on, lint off).

New `gateConfigFor(repoName)` function merges global → repo-level config using existing `configGet()`/`configRepoDetail()`.

## Schema & Events

### New task field

`gate_results TEXT` — JSON string storing the `GateResult[]` from the last gate run. Displayed by dashboard, `grove tasks`, and `grove log`.

### New event types

- `GatePassed` = `"gate_passed"` — all gates passed
- `GateFailed` = `"gate_failed"` — one or more gates failed
- `GateRetry` = `"gate_retry"` — hard gate failed, auto-retrying

No new tables. Gate results on the task row are ephemeral (overwritten each run). Events provide the audit trail.

## Decisions

- **Pre-publish hook** — gates run between worker completion and PR creation, preventing bad PRs entirely.
- **Tiered gates** — hard gates (commits, tests) auto-retry; soft gates (lint, diff size) mark for human review. Matches how a human would respond.
- **Separate module** — `gates.ts` is independently testable. Dispatch just calls `runGates()`.
- **Reuse scanner toolchain detection** — no duplication of test/lint runner discovery.
- **Global + per-repo config** — sensible defaults, repos can opt out (CFML repos have no npm test runner).
- **Existing retry infrastructure** — `max_retries` and `retry_count` already in schema, just need to wire them up.
- **Output capture for retries** — failed gate output goes into the retry prompt so the next worker knows exactly what to fix.

## Unresolved Questions

- Should `max_retries` have a default when quality gates are enabled? Currently defaults to NULL (no retries).
- Should gate results be visible in `grove dashboard` live status, or only after completion?
- Should `grove work --skip-gates` be an escape hatch for manual overrides?
