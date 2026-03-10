# Continuous Drain Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `grove drain` command — a continuous queue drainer that maintains N concurrent workers, auto-dispatches newly unblocked tasks, and runs until the queue is empty.

**Architecture:** Extract shared dispatch helpers from `work.ts` into `src/lib/dispatch.ts`. Build `src/commands/drain.ts` that uses those helpers to implement a poll-based dispatch loop with slot management, budget checks, and a live status table. Register the command in `src/index.ts`.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test

---

### Task 1: Extract shared dispatch helpers to `src/lib/dispatch.ts`

**Files:**
- Create: `src/lib/dispatch.ts`
- Modify: `src/commands/work.ts:1-534` (remove extracted functions, add imports)

The following functions and constants move from `work.ts` to `dispatch.ts`:
- `parseCosts()` (lines 21-66)
- `readSessionSummary()` (lines 68-79)
- `getFilesModified()` (lines 81-97)
- `notifyUnblocked()` (lines 99-107)
- `dispatchTask()` (lines 119-483)
- `ANSI` constant (lines 490-501)
- `formatElapsed()` (lines 503-514)
- `batchStatusIcon()` (lines 516-524)
- `batchStatusLabel()` (lines 526-534)
- `renderBatchStatus()` (lines 540-586)

**Step 1: Create `src/lib/dispatch.ts` with all extracted functions**

Copy every function body exactly from `work.ts`. The only changes are:
1. Add `export` to every function and the `ANSI` constant
2. Imports at the top of the file reference `../core/db`, `../core/config`, `../core/ui`, `../core/prompts`, `./worktree`, `./sandbox`, `../commands/publish`, `../types`
3. The `publishTask` import path changes from `"./publish"` to `"../commands/publish"`

**Step 2: Update `work.ts` to import from dispatch.ts**

Replace the top of `work.ts` (lines 1-586) with:

```typescript
// grove work / grove run — Core dispatch engine
// Selects a task, creates a worktree, spawns a Claude worker session.
import { getDb } from "../core/db";
import { budgetGet, settingsGet } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import {
  dispatchTask,
  ANSI,
  renderBatchStatus,
} from "../lib/dispatch";
import type { Command, Task } from "../types";
```

Remove all the extracted function definitions (lines 20-586 in current work.ts). Keep only the command entry point (`workCommand` object starting at line 592) and everything after it.

**Step 3: Run all existing tests to verify no regression**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All 223 tests pass. The extraction is purely mechanical — no behavior changes.

**Step 4: Commit**

```bash
git add src/lib/dispatch.ts src/commands/work.ts
git commit -m "refactor: extract shared dispatch helpers to src/lib/dispatch.ts"
```

---

### Task 2: Write drain command tests

**Files:**
- Create: `tests/commands/drain.test.ts`

**Step 1: Write the test file**

Follow the same pattern as `tests/commands/work.test.ts` — create a temp dir, initialize DB with schema, write grove.yaml, insert repo record. Test the drain's queue logic without spawning actual claude processes.

Tests to include:

**describe("drain queue building")**
- `collects ready and planned tasks, excludes blocked` — insert ready, planned, blocked-by-missing-dep, done, and running tasks. Query for ready/planned, filter with `isTaskBlocked()`, verify only unblocked tasks pass.
- `newly unblocked tasks enter the queue` — insert a done task and two dependents (one fully satisfied, one still blocked). Verify `isTaskBlocked()` returns correct values.
- `getNewlyUnblocked finds tasks freed by completion` — insert tasks with deps, simulate completion, verify `getNewlyUnblocked()` returns the right set.

**describe("drain slot management")**
- `respects concurrency limit` — insert 6 ready tasks, verify slot math with max_concurrent=4 and 0 running, then with 2 running.
- `budget check prevents dispatch when exceeded` — insert a task with estimated_cost, add a session consuming most budget, verify the math shows budget exceeded.

**describe("drain --dry-run")**
- `reports tasks that would be dispatched` — insert ready, planned, and blocked tasks, verify the unblocked/blocked partitioning.

**describe("drain termination")**
- `terminates when queue empty and no running tasks` — insert only done/completed tasks, verify empty candidate list and zero running count.

**Step 2: Run the tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/drain.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add tests/commands/drain.test.ts
git commit -m "test: add drain command queue logic tests"
```

---

### Task 3: Implement `src/commands/drain.ts`

**Files:**
- Create: `src/commands/drain.ts`

**Step 1: Write the drain command**

The command structure:

1. **Argument parsing:** `-n SLOTS` (override concurrency), `--dry-run`, `-h`/`--help`
2. **Initial queue build:** Query `ready`/`planned` tasks, partition into `queue` (unblocked) and `blockedIds`
3. **Dry run path:** Print queue contents and estimated cost, then return
4. **Main dispatch loop:**
   - Fill slots: while `activeIds.length < maxSlots && queue.length > 0`, do budget check then `dispatchTask(id, false)`
   - Terminate check: break if `activeIds.length === 0 && queue.length === 0`
   - Render status via `renderBatchStatus(allDispatchedIds, isFirstRender)`
   - Poll wait: 3 seconds
   - Check active workers: for each active ID, check if task reached terminal status. If done/completed, call `db.getNewlyUnblocked(id)` and push new IDs to queue. Track done/failed counts.
   - Budget exhaustion: if all remaining queue items exceed budget and no active workers, break with warning.
5. **Ctrl+C handler:** Hide cursor on start, show on exit, SIGINT/SIGTERM detach cleanly
6. **Final summary:** Print done/failed counts, total cost, duration, auto-enqueued count

Import from `../lib/dispatch`: `dispatchTask`, `ANSI`, `renderBatchStatus`
Import from `../core/db`: `getDb`
Import from `../core/config`: `budgetGet`, `settingsGet`
Import from `../core/ui`: `* as ui`

**Step 2: Run the tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/drain.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/commands/drain.ts
git commit -m "feat: add grove drain command for continuous queue draining"
```

---

### Task 4: Register drain in command router

**Files:**
- Modify: `src/index.ts:21-49` (add drain case to loadCommand switch)
- Modify: `src/index.ts:61-69` (add "drain" to allCommandNames)

**Step 1: Add drain to loadCommand**

In `src/index.ts`, add a new case inside the `loadCommand` switch statement, after the `"run"` case (line 30):

```typescript
    case "drain": return (await import("./commands/drain")).drainCommand;
```

**Step 2: Add drain to allCommandNames**

In `src/index.ts`, add `"drain"` to the `allCommandNames` array. Place it after `"run"` in the execution group:

```typescript
const allCommandNames = [
  "init", "config", "repos", "help",
  "hud", "status",
  "add", "tasks", "plan", "prioritize", "sync",
  "work", "run", "drain", "resume", "pause", "cancel",
  "watch", "detach", "msg", "dashboard",
  "prs", "review", "done", "publish", "close", "delete",
  "report", "cost", "log",
];
```

**Step 3: Run all tests**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass (223 existing + new drain tests).

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register drain command in router"
```

---

### Task 5: Update help command with drain

**Files:**
- Modify: `src/commands/help.ts` — add drain to the command listing

**Step 1: Read help.ts to find the execution/dispatch section**

Find where `work`, `run`, `resume` are listed and add:

```
  grove drain              Continuously dispatch until queue empty
```

Place it after `grove run` and before `grove resume`.

**Step 2: Run tests**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/commands/help.ts
git commit -m "docs: add drain command to help listing"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 2: Build the binary**

Run: `/Users/peter/.bun/bin/bun build src/index.ts --compile --outfile bin/grove`
Expected: Binary compiles successfully.

**Step 3: Verify help output**

Run: `bin/grove drain -h`
Expected: Shows drain command usage.

**Step 4: Verify dry-run (requires initialized grove)**

Run: `bin/grove drain --dry-run`
Expected: Shows "No tasks ready to drain" or lists queued tasks.

---

## Unresolved Questions

- Should `drain` also pick up `ingested` tasks (auto-plan then auto-ready then dispatch), or only `ready`/`planned`? Current design: only `ready`/`planned`, matching `--batch` behavior.
- Should there be a `--repo` filter on drain? Omitted for now — YAGNI.
- Should drain show individual task dispatch logs or just the status table? Current design: status table only, since multiple workers run simultaneously.
