# Continuous Drain Design

## Goal

`grove drain` — a continuous queue drainer that maintains N concurrent workers, auto-dispatches newly unblocked tasks, and runs until the queue is empty.

## Motivation

`grove work --batch N` is one-shot: dispatch N tasks, monitor, done. It doesn't refill slots when workers finish, and doesn't auto-dispatch tasks that become unblocked by completed dependencies. For a dependency chain A→B→C, you'd need to run `--batch` three times.

`grove drain` fills this gap: one invocation works through the entire queue, including dependency chains, with continuous slot management.

## Interface

```
grove drain              # use max_concurrent setting (default 4)
grove drain -n 3         # override to 3 concurrent slots
grove drain --dry-run    # show what would be dispatched, don't start
grove drain -h           # help
```

## Architecture

- New file: `src/commands/drain.ts`
- Shared module: `src/lib/dispatch.ts` — extracted from `work.ts`
- Reuses `dispatchTask()` (background mode), `renderBatchStatus()`, and helpers
- No new DB tables or schema changes

## Dispatch Loop

1. Read initial queue: all tasks with status `ready`/`planned`, filtered by `isTaskBlocked()`
2. Fill slots up to N with `dispatchTask(id, false)`
3. Poll every 3s:
   a. Check each active worker's task status in DB
   b. For any that reached terminal state (`done`/`completed`/`failed`):
      - Remove from active set
      - If done: call `getNewlyUnblocked()`, add unblocked tasks to queue
   c. If slots available and queue non-empty:
      - Budget check before each dispatch
      - Dispatch next task from queue
   d. Render live status table (reuse `renderBatchStatus`)
4. Terminate when: active set empty AND queue empty

## Failure Handling

Failed tasks are logged and skipped. The drain continues with remaining tasks. Failed tasks stay in "failed" status for manual review or `grove resume`.

## Budget Enforcement

Before each individual dispatch, check `weekCost + estimated_cost <= weekBudget`. If exceeded, skip that task with a warning. If ALL remaining tasks would exceed budget, terminate with a budget-exhausted message.

## Dependency-Aware Scheduling

When a task completes and `getNewlyUnblocked()` returns newly-ready tasks, those are appended to the drain queue. This means a single `grove drain` invocation works through an entire dependency chain: A finishes → B unblocks and gets dispatched → B finishes → C gets dispatched.

## Ctrl+C Behavior

Same as batch mode: detach cleanly, print message, workers continue in background.

## Output

Live status table (reuses `renderBatchStatus` from batch mode), extended to show new tasks as they enter the queue.

Summary on exit:
```
Drain complete: 8 done, 1 failed, $2.45 total
  Duration: 14:32
  Unblocked: 3 tasks auto-dispatched
```

## Extraction from work.ts

These functions move from `work.ts` to `src/lib/dispatch.ts`:
- `dispatchTask()` — core dispatch logic
- `parseCosts()` — log file cost parsing
- `readSessionSummary()` — session summary reader
- `getFilesModified()` — git diff helper
- `notifyUnblocked()` — dependency unblock notification
- `renderBatchStatus()` and batch rendering helpers (`formatElapsed`, `batchStatusIcon`, `batchStatusLabel`, ANSI constants)

`work.ts` re-imports these from the shared module. No behavior change for existing commands.

## Decisions

| Question | Decision |
|----------|----------|
| Scope | Continuous queue drainer (not one-shot enhancement) |
| Interface | New `grove drain` command (not flag on `grove work`) |
| Failure | Skip and continue (no retry, no pause) |
| Unblocked tasks | Auto-enqueue into drain queue |
| Concurrency | `-n` flag, falls back to `max_concurrent` setting |
