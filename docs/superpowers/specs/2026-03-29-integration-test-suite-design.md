# Integration Test Suite Design

**Issue:** #39 (scoped to tests only — analytics moved to #40)
**Date:** 2026-03-29

## Goal

Expand test coverage from 121 tests to ~220+ by adding unit tests for the four untested core modules: evaluator gates, step engine, cost monitor, and stream parser. No source logic changes — only export visibility tweaks and new test files.

## Approach

Pure unit tests (Approach A). Each module's exported functions tested directly. Real git repos for evaluator, real SQLite for step engine and cost monitor, temp JSONL files for stream parser. No Claude Code invocations, no network calls.

## Source Changes (exports only)

### `src/agents/evaluator.ts`

Export existing internal functions for direct testing:

- `capOutput`
- `checkCommits`, `checkDiffSize`, `checkTests`, `checkLint`
- `resolveBaseRef`, `resolveGateConfig`, `parseBaseRefFromConfig`
- `runGates`

No logic changes.

### `src/monitor/cost.ts`

Export for testing:

- `checkBudgets` — currently private, needed for direct budget threshold testing
- `resetPausedState()` — new one-liner to reset module-level `spawningPaused` between tests

## New Files

### 1. `tests/fixtures/helpers.ts`

Shared test factories. Not a test file — no test cases.

**`createTestDb()`**
- Creates temp SQLite DB initialized with `SCHEMA_SQL`
- Returns `{ db: Database, cleanup: () => void }`
- Cleanup removes DB + WAL + SHM files

**`createFixtureRepo(opts?)`**
- Creates a real git repo in `os.tmpdir()` via `git init`
- Options: initial commit (default: yes), extra files, branches
- Returns `{ repoPath: string, cleanup: () => void }`
- Used by evaluator tests

### 2. `tests/agents/evaluator-gates.test.ts`

~35 tests. Real git repos created in `beforeAll`, cleaned in `afterAll`.

**`capOutput`** (3 tests):
- String under 5KB limit → returned as-is
- String at limit → returned as-is
- String over limit → truncated with `[... truncated]` suffix

**`parseBaseRefFromConfig`** (4 tests):
- `null` → `undefined`
- JSON with `quality_gates.base_ref` → returns ref
- JSON with `default_branch` only → returns `origin/{branch}`
- Invalid JSON → `undefined`

**`resolveBaseRef`** (3 tests):
- Config ref provided → uses it directly
- No config ref, repo has `main` branch → detects `main`
- No config ref, no recognized branches → falls back to `origin/main`

**`resolveGateConfig`** (3 tests):
- `null` → returns `DEFAULT_GATE_CONFIG`
- Partial JSON overrides → merged with defaults
- `quality_gates` nested key → extracted correctly

**`checkCommits`** (2 tests):
- Branch with commits ahead of base → `{ passed: true, tier: "hard" }`
- Branch with no commits → `{ passed: false, tier: "hard" }`

**`checkDiffSize`** (4 tests):
- Diff below min → `{ passed: false, tier: "soft" }`
- Diff within range → `{ passed: true }`
- Diff above max → `{ passed: false, tier: "soft" }`
- Zero diff (no changes) → fails min check

**`checkTests`** (3 tests):
- No test command → `{ passed: true, message: "...skipped" }`
- Passing command (e.g. `"true"`) → `{ passed: true }`
- Failing command (e.g. `"false"`) → `{ passed: false }` with output

**`checkLint`** (3 tests):
- No lint command → `{ passed: true, message: "...skipped" }`
- Passing command → `{ passed: true }`
- Failing command → `{ passed: false }`

**`runGates`** (3 tests):
- All gates enabled → runs all, returns array
- Selectively disabled gates → only enabled gates run
- Hard failure + soft failure → both in results

**`evaluate()`** (5 tests):
- Missing worktree → `{ passed: false, feedback: "Worktree not found" }`
- All gates pass → `{ passed: true }`, session ended as "completed"
- Hard gate failure → `{ passed: false }`, session ended as "failed"
- Soft-only failures → `{ passed: true }` (soft gates don't block)
- Gate results stored on task row (`gate_results` column)

**`buildRetryPrompt()`** (3 tests):
- No failures → empty string
- Failures with output → includes gate names, messages, truncated output
- Failures with seed spec → appends seed section

### 3. `tests/engine/step-engine.test.ts`

~25 tests. Real DB. `configNormalizedPaths()` mocked via `mock.module()`. Dynamic imports (`worker`, `evaluator`, `merge/manager`) mocked to stub `spawnWorker`, `evaluate`, `queueMerge`.

**`normalizePath()`** (10 tests):
- String step `"implement"` → type `worker`, default transitions
- String step `"merge"` → type inferred as `merge`
- String step `"evaluate"` → type inferred as `gate`
- Object step with `id` key → uses explicit props
- Object shorthand `{ plan: { prompt: "..." } }` → extracts id from key
- `on_success` auto-wiring: intermediate → next step, last → `$done`
- `on_failure` defaults to `$fail`
- `label` auto-capitalization
- Multi-step path → full chain wired correctly
- `stripPrompts()` removes prompt fields from all steps

**`startPipeline()`** (5 tests):
- Valid path config → task set to `active`, first step entered
- Missing/empty path config → task set to `failed`
- Seeded task + first step is `plan` worker → skips to second step
- Seeded task + first step is not `plan` → starts normally
- Single-step path with seed → doesn't skip

**`onStepComplete()`** (7 tests):
- Success → `$done` → task `completed`, `completed_at` set, `merge:completed` emitted
- Success → next step-id → `current_step` and `step_index` updated
- Failure → `$fail` with retries remaining → `retry_count` incremented, same step re-entered
- Failure → `$fail` with retries exhausted → task `failed`, `retry_exhausted` event
- Invalid transition target → task failed
- Missing path config → task failed
- Missing current step → task failed

**`wireStepEngine()`** (1 test):
- `merge:completed` → unblocked tasks get enqueued

### 4. `tests/monitor/cost.test.ts`

~15 tests. Real DB with seeded session costs. Bus events captured via listeners. `resetPausedState()` called in `beforeEach`.

**`checkTaskBudget()`** (4 tests):
- Task under budget → `{ ok: true }`
- Task at exact budget → `{ ok: false }` (strict `<`)
- Task over budget → `{ ok: false }`
- New task (zero cost) → `{ ok: true, current: 0 }`

**`checkBudgets()`** (8 tests):
- Daily under 80% → no events
- Daily at 80% → `cost:budget_warning` emitted
- Daily at 100% → `cost:budget_exceeded`, `isSpawningPaused()` true
- Weekly at 80% → warning
- Weekly at 100% → exceeded, paused
- Both over → pauses once (idempotent, no double emit)
- Spend drops under both → `isSpawningPaused()` resets to false
- Already paused + still over → no duplicate `budget_exceeded` event

**`startCostMonitor()` / `stopCostMonitor()`** (3 tests):
- Idempotent start (two calls, one interval)
- Immediate check on start
- Stop clears interval

### 5. `tests/agents/stream-parser.test.ts`

~27 tests. Temp JSONL files for file-based functions, direct string args for formatters.

**`isAlive()`** (4 tests):
- `null` / `undefined` → false
- `0` / negative → false
- `process.pid` → true
- Non-existent large PID → false

**`parseCost()`** (6 tests):
- Non-existent file → zeros
- Empty file → zeros
- No `result` line → zeros
- Valid `result` line → extracts cost and tokens
- Multiple `result` lines → uses last one
- Mixed valid JSON and garbage → skips garbage

**`lastActivity()`** (8 tests):
- Non-existent file → `"no log"`
- Empty file → `"idle"`
- `tool_use` edit → `"editing {file}"`
- `tool_use` read → `"reading {file}"`
- `tool_use` bash with test pattern → `"running tests"`
- `tool_use` bash with git → `"running git command"`
- `tool_use` grep/glob → `"searching codebase"`
- `result` type → `"completed"`

**`formatStreamLine()`** (6 tests):
- Empty/whitespace → `null`
- Non-JSON text → `{ type: "text" }`
- `assistant` with content → `{ type: "text" }`
- `tool_use` → `{ type: "tool_use", text: "[name] detail" }`
- `result` with cost → includes formatted cost
- `error` → `{ type: "error" }`

**`parseBrokerEvent()`** (3 tests):
- Empty → `null`
- Invalid JSON → `null`
- Valid JSON with `type` → returns as `BrokerEvent`

## Test Count

| File | Tests |
|------|-------|
| `tests/fixtures/helpers.ts` | 0 (factory) |
| `tests/agents/evaluator-gates.test.ts` | ~35 |
| `tests/engine/step-engine.test.ts` | ~25 |
| `tests/monitor/cost.test.ts` | ~15 |
| `tests/agents/stream-parser.test.ts` | ~27 |
| **Existing** | **121** |
| **Total** | **~223** |

## Constraints

- All tests use Bun's native test runner (`bun:test`)
- No Claude Code invocations in tests
- No network calls
- Evaluator tests use real git repos (temp dirs)
- Target: all tests pass in <30 seconds (expect <10s)
- CI runs all tests on PR (existing `bun test tests/` command)
