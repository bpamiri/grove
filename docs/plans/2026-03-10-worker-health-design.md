# Worker Health Monitoring Design

**Goal:** Detect and clean up dead/stalled workers that leave zombie "running" entries in the DB, blocking drain slots and showing stale dashboard status.

**Problem:** Background workers that die (crash, OOM, external kill) or stall (hung Claude session) leave tasks as "running" forever. Only fix today is manual `grove cancel`.

## Architecture

### New module: `src/lib/reaper.ts`

Two core functions:

**`reapDeadWorkers(db): ReapResult[]`**
- Scans all `sessions WHERE status = 'running'`
- Checks `isAlive(pid)` for each
- Dead PIDs: parse final cost from log, end session as failed, mark task failed, log `worker_reaped` event
- Captures session summary + files modified if worktree exists
- Returns `{ taskId, pid, reason: "dead" }[]`

**`reapStalledWorkers(db, timeoutMinutes): ReapResult[]`**
- Same session query, filtered to alive PIDs
- Checks log file `mtime` via `statSync()`
- If idle > `timeoutMinutes * 60_000`: SIGTERM → 3s wait → SIGKILL
- Same cleanup as dead reaper
- Event detail: "No output for {N} minutes (stall timeout)"
- Returns `{ taskId, pid, reason: "stalled" }[]`

**Worktrees preserved** — unlike `cancel`, reaped tasks keep worktrees for inspection.

### New command: `src/commands/health.ts`

```
grove health              Report table of all running workers
grove health --reap       Report + kill dead/stalled workers
```

Report columns: TASK, REPO, PID, STATUS (alive/dead), LAST ACTIVITY, IDLE time.
Shows ⚠ when idle exceeds stall timeout.

### Config

`stall_timeout_minutes` — read via `settingsGet()`, default 10.

### Integration

- **drain.ts**: call both reaper functions each poll cycle (3s)
- **dashboard.ts**: call `reapDeadWorkers()` on each refresh
- No changes to `renderBatchStatus()` — it reads from DB which the reaper updates

## Decisions

- **Failed, not new status** — reaped tasks go to `failed`. No new `stalled` status. Users retry via `grove work TASK_ID`.
- **No auto-retry** — stalled workers already wasted budget. User decides whether to retry.
- **Configurable timeout** — `stall_timeout_minutes` via `grove config`, default 10. Covers long test suites.
- **Reaper is a library, not a daemon** — called from drain/dashboard/health command. No persistent background process.
