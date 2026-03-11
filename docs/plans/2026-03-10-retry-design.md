# Automatic Retry for Failed Tasks

**Goal:** Let drain auto-retry failed tasks up to a configurable limit, with per-task override, so transient failures recover without manual intervention.

**Problem:** Failed tasks require manual `grove work TASK_ID` to re-dispatch. Drain counts failures but doesn't retry. Large batch operations with flaky failures stall.

## Architecture

### Retry logic lives in drain only

Drain's poll loop already detects terminal task states. When a task reaches `failed`:
1. Check `retry_count < effective_max_retries`
2. If retriable: increment `retry_count`, set status to `ready`, log `auto_retried` event, push back onto drain's `queue`
3. If exhausted: log `retry_exhausted` event, leave as `failed`

Manual dispatch (`grove work TASK_ID`) unchanged — still converts failed to ready without incrementing `retry_count`.

### No backoff delay

Drain's 3s poll cycle + slot-filling order provides natural spacing. Failed tasks re-enter the queue behind any already-queued tasks.

### Retry all failure types

No distinction between retryable/non-retryable. With max_retries defaulting to 2, cost of retrying a "real" failure is bounded.

## Schema Changes

Two new columns on `tasks`:

- `retry_count INTEGER DEFAULT 0` — how many times this task has been auto-retried by drain
- `max_retries INTEGER DEFAULT NULL` — per-task override (NULL = use global setting)

Added via `ALTER TABLE` in DB init path (check if column exists, add if missing).

## Config

`max_retries` added to `SettingsConfig` (default 2). Set via `grove config settings.max_retries N`.

Effective max for a task: `task.max_retries ?? settingsGet("max_retries") ?? 2`

## Drain Integration

In the poll loop, after detecting a task reached `failed` status:

- Calculate effective_max = task.max_retries ?? settingsGet("max_retries") ?? 2
- If task.retry_count < effective_max:
  - Increment retry_count in DB
  - Set status back to "ready"
  - Log auto_retried event with "Auto-retry N/max"
  - Push taskId back onto queue
  - Increment stats.autoRetried
- Else:
  - Log retry_exhausted event
  - Increment stats.totalFailed

Task goes back to `queue` (not `activeIds`), so it gets a fresh dispatch with new session/log file.

### Drain summary

New line: `Auto-retried: N` alongside Done/Failed/Auto-enqueued.

### Drain --dry-run

Shows retry limits per task: `[retries: 0/2]`.

## Event Types

- `AutoRetried = "auto_retried"` — task re-enqueued after failure
- `RetryExhausted = "retry_exhausted"` — task stayed failed after max retries

## Command Changes

### grove add

- `--max-retries N` — per-task retry limit
- `--no-retry` — shorthand for `--max-retries 0`

### Dashboard / status display

Show `retry_count` next to tasks when > 0, e.g. "W-005 (retry 1/2)"

## Decisions

- **Drain-only** — retry logic in drain's poll loop, not in dispatchTask(). Manual dispatch stays simple.
- **No backoff** — natural spacing from drain's poll cycle is sufficient.
- **Retry all failures** — no failure categorization. Max retries bounds the cost.
- **Global + per-task** — global default via settings, per-task override via --max-retries.
- **Manual dispatch doesn't count** — `grove work TASK_ID` on a failed task is deliberate, doesn't increment retry_count.
- **Fresh dispatch on retry** — new session, new log file, existing worktree reused if present.

## Unresolved Questions

- Should retry_count reset when a user manually dispatches a previously-exhausted task?
- Should retried tasks preserve or discard the previous worktree? (Current: reuse if exists)
- Should `grove status TASK_ID` show retry history from events?
