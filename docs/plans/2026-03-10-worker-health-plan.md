# Worker Health Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a reaper module that detects dead/stalled workers and a `grove health` command to inspect and clean them up, integrated into drain and dashboard poll loops.

**Architecture:** New `src/lib/reaper.ts` module exports `reapDeadWorkers()` and `reapStalledWorkers()`. New `src/commands/health.ts` provides a report table + `--reap` flag. Drain and dashboard call the reaper each cycle. Stall timeout is configurable via `settings.stall_timeout_minutes` (default 10).

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test

---

### Task 1: Add `stall_timeout_minutes` to SettingsConfig type

**Files:**
- Modify: `src/types.ts:165-169`

**Step 1: Add the field to SettingsConfig**

In `src/types.ts`, add `stall_timeout_minutes` to the `SettingsConfig` interface:

```typescript
export interface SettingsConfig {
  max_concurrent: number;
  branch_prefix: string;
  auto_sync: boolean;
  stall_timeout_minutes: number;
}
```

**Step 2: Run tests**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass. This is a type-only change.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add stall_timeout_minutes to SettingsConfig"
```

---

### Task 2: Write reaper tests

**Files:**
- Create: `tests/lib/reaper.test.ts`

**Step 1: Write the test file**

Follow the same pattern as `tests/commands/drain.test.ts` — temp dir, init DB with schema, grove.yaml, repo record. Test reaper logic by inserting sessions with known PIDs (use PID 0 and PID 99999999 as guaranteed-dead PIDs) and log files with known mtimes.

Tests to include:

**describe("reapDeadWorkers")**
- `detects dead PID and marks task failed` — insert running task with PID 99999999, verify reaper marks it failed, ends session, logs worker_reaped event
- `skips sessions with null PID` — insert running task with PID 0, verify reaper treats it as dead
- `ignores non-running sessions` — insert completed session with dead PID, verify reaper skips it
- `parses cost from log file when reaping` — insert running task with dead PID + log file containing result JSON, verify cost/tokens captured

**describe("reapStalledWorkers")**
- `detects stalled worker by log mtime` — dead PIDs are handled by reapDeadWorkers, not stall reaper (only acts on alive PIDs)
- `skips workers with recent log activity` — insert running task with dead PID + fresh log, verify stall reaper skips it

**describe("reaper integration")**
- `running both reapers doesn't double-reap` — dead reaper picks up dead PID first, stall reaper finds nothing
- `reaping frees drain slots` — insert 2 running tasks with dead PIDs, verify taskCount("running") goes from 2 to 0 after reap

**Step 2: Run the tests (should fail — module doesn't exist yet)**

Run: `/Users/peter/.bun/bin/bun test tests/lib/reaper.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/reaper`

**Step 3: Commit**

```bash
git add tests/lib/reaper.test.ts
git commit -m "test: add reaper module tests (dead/stalled worker detection)"
```

---

### Task 3: Implement `src/lib/reaper.ts`

**Files:**
- Create: `src/lib/reaper.ts`

**Step 1: Write the reaper module**

The module exports:
- `ReapResult` interface: `{ taskId: string; pid: number; reason: "dead" | "stalled" }`
- `reapDeadWorkers(db: Database): ReapResult[]`
- `reapStalledWorkers(db: Database, timeoutMinutes: number): ReapResult[]`
- Internal `cleanupReapedSession()` shared by both

**`reapDeadWorkers`:**
1. Query `sessions WHERE status = 'running'`
2. For each: `isAlive(pid)` — if false, call `cleanupReapedSession()`
3. Return results

**`reapStalledWorkers`:**
1. Query `sessions WHERE status = 'running'`
2. For each: if `isAlive(pid)` is true, check `statSync(logFile).mtimeMs`
3. If `Date.now() - mtime > timeoutMinutes * 60_000`: SIGTERM, wait 3s, SIGKILL if needed
4. Call `cleanupReapedSession()`
5. Return results

**`cleanupReapedSession`:**
1. Parse cost from log via `parseCosts()` from dispatch.ts
2. Update task + session cost/tokens
3. Capture session summary + files modified if worktree exists
4. `db.sessionEnd(session.id, "failed")`
5. `db.taskSetStatus(taskId, "failed")`
6. `db.addEvent(taskId, "worker_reaped", detail)`

Imports: `isAlive` from `../lib/monitor`, `parseCosts`/`readSessionSummary`/`getFilesModified` from `./dispatch`, `statSync` from `node:fs`

**Step 2: Run the reaper tests**

Run: `/Users/peter/.bun/bin/bun test tests/lib/reaper.test.ts`
Expected: All tests pass.

**Step 3: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/lib/reaper.ts
git commit -m "feat: add reaper module for dead/stalled worker detection"
```

---

### Task 4: Write health command tests

**Files:**
- Create: `tests/commands/health.test.ts`

**Step 1: Write the test file**

Tests to include:

**describe("health report data")**
- `lists running sessions with PID status` — insert running task with dead PID, verify session query returns it
- `reports no workers when none running` — insert completed task/session, verify empty running sessions

**describe("health --reap")**
- `reap cleans up dead workers` — insert running task with dead PID, run reapDeadWorkers, verify task status is failed

**Step 2: Run the tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/health.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add tests/commands/health.test.ts
git commit -m "test: add health command tests"
```

---

### Task 5: Implement `src/commands/health.ts`

**Files:**
- Create: `src/commands/health.ts`

**Step 1: Write the health command**

The command:
1. **Arg parsing:** `--reap`, `-h`/`--help`
2. **Query:** `sessions WHERE status = 'running'`
3. **Report table:** TASK, REPO, PID, STATUS (alive/dead), LAST ACTIVITY (from `lastActivity()` in monitor.ts), IDLE (from log file mtime, with warning icon when over stall timeout)
4. **`--reap` mode:** Call `reapDeadWorkers()` + `reapStalledWorkers()`, print what was cleaned up
5. **Hint:** If dead workers detected and not in reap mode, suggest `grove health --reap`

Stall timeout read from `settingsGet("stall_timeout_minutes") || 10`.

Imports: `getDb` from `../core/db`, `settingsGet` from `../core/config`, `isAlive`/`lastActivity` from `../lib/monitor`, `reapDeadWorkers`/`reapStalledWorkers` from `../lib/reaper`, `statSync` from `node:fs`

Help text includes: usage, options, config key explanation, examples.

**Step 2: Run health tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/health.test.ts`
Expected: All tests pass.

**Step 3: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/commands/health.ts
git commit -m "feat: add grove health command for worker health reporting"
```

---

### Task 6: Register health in command router and help

**Files:**
- Modify: `src/index.ts:20-50` (add health to loadCommand switch)
- Modify: `src/index.ts:62-70` (add "health" to allCommandNames)
- Modify: `src/commands/help.ts:52-59` (add health to Monitoring section)

**Step 1: Add health to loadCommand switch**

In `src/index.ts`, add a new case after the `"dashboard"` case (line 37):

```typescript
    case "health": return (await import("./commands/health")).healthCommand;
```

**Step 2: Add health to allCommandNames**

In `src/index.ts`, add `"health"` after `"dashboard"` in the Monitoring group:

```typescript
  "watch", "detach", "msg", "dashboard", "health",
```

**Step 3: Add health to help listing**

In `src/commands/help.ts`, add to the Monitoring section after `"grove dashboard"`:

```
        "grove health       Worker health report + reap",
```

**Step 4: Run all tests**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/index.ts src/commands/help.ts
git commit -m "feat: register health command in router and help"
```

---

### Task 7: Integrate reaper into drain poll loop

**Files:**
- Modify: `src/commands/drain.ts:1-10` (add import)
- Modify: `src/commands/drain.ts:152-240` (add reaper calls in main loop)

**Step 1: Add reaper import**

Add to drain.ts imports (after the existing dispatch import on line 5):

```typescript
import { reapDeadWorkers, reapStalledWorkers } from "../lib/reaper";
```

**Step 2: Add reaper calls in the poll loop**

In drain.ts, inside the `while (true)` loop, after the poll wait (`await new Promise(...)` on line 188) and before checking active workers (line 191), add:

```typescript
        // Reap dead/stalled workers (frees slots for next iteration)
        const stallTimeout = settingsGet("stall_timeout_minutes") || 10;
        const deadReaped = reapDeadWorkers(db);
        const stalledReaped = reapStalledWorkers(db, stallTimeout);
        for (const r of [...deadReaped, ...stalledReaped]) {
          if (activeIds.includes(r.taskId)) {
            stats.totalFailed++;
          }
        }
```

**Step 3: Run drain tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/drain.test.ts`
Expected: All tests pass.

**Step 4: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/commands/drain.ts
git commit -m "feat: integrate reaper into drain poll loop"
```

---

### Task 8: Integrate reaper into dashboard refresh

**Files:**
- Modify: `src/commands/dashboard.ts` (add reaper import + call in refresh cycle)

**Step 1: Read dashboard.ts to find the refresh loop**

Read `src/commands/dashboard.ts` fully. Find where the render/refresh cycle runs (likely a `setInterval` or `while` loop).

**Step 2: Add reaper import**

Add at top of dashboard.ts:

```typescript
import { reapDeadWorkers } from "../lib/reaper";
```

**Step 3: Add reaper call in refresh function**

In the refresh/render function, add at the start (before building the display data):

```typescript
    reapDeadWorkers(db);
```

Only `reapDeadWorkers` — not stall reaper. Dashboard is a display tool. Dead PID checks are cheap. Stall detection with SIGTERM/SIGKILL is aggressive and belongs in drain/`grove health --reap`.

**Step 4: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/commands/dashboard.ts
git commit -m "feat: integrate dead worker reaper into dashboard refresh"
```

---

### Task 9: Final verification

**Step 1: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 2: Build the binary**

Run: `/Users/peter/.bun/bin/bun build src/index.ts --compile --outfile bin/grove`
Expected: Binary compiles successfully.

**Step 3: Verify health help output**

Run: `bin/grove health -h`
Expected: Shows health command usage.

**Step 4: Verify health report (no workers)**

Run: `bin/grove health`
Expected: "No running workers."

---

## Unresolved Questions

- Should `grove health --reap` also clean up orphaned worktrees whose tasks are terminal? Omitted — that's a separate "worktree cleanup" feature.
- Should the stall timeout reset when the log file grows (even if mtime doesn't update due to buffering)? Using mtime for now — simpler and correct for Bun's file writer which flushes frequently.
- Should reaper integration in drain double-count tasks it reaped that were also in drain's activeIds? Current plan: yes, count them in `stats.totalFailed` — drain already removes them from activeIds on next check cycle.
