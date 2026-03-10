# Batch Dispatch Design

## Goal

Add `grove work --batch N` to dispatch N tasks from the priority queue in parallel, with a live status display that stays until all workers finish.

## UX

```
grove work --batch 5
```

Picks the top 5 ready/planned/ingested tasks from the priority queue. All dispatch in background. CLI stays alive showing a compact live status table that updates every 3 seconds until all workers reach a terminal state.

Example output:

```
grove work --batch 5

  W-012  titan       Refactor auth module     ⚙ running   0:42
  W-013  pai-man     Fix MES dashboard        ✓ done      1:15  $0.23
  W-014  pai-chat    Add typing indicators     ⚙ running   0:38
  W-015  titan       Update search index       ✗ failed    0:12  $0.04
  W-016  pai-man     Export CSV endpoint        ⚙ running   0:22

  3 running · 1 done · 1 failed · $0.27 total
```

Ctrl+C detaches cleanly — workers continue in background.

## Architecture

**No new files.** ~100 lines added to `src/commands/work.ts`:

1. **Arg parsing**: `--batch N` flag (integer > 0). Incompatible with `--repo` and explicit task IDs — error if combined.
2. **Task selection**: Reuse existing query `SELECT ... WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT N`.
3. **Constraint check**: Actual dispatch count = `min(N, max_concurrent, budget headroom)`. Warn if capped.
4. **Dispatch loop**: Call `dispatchTask(id, false)` for each task (all background).
5. **Live monitor**: Poll DB every 3 seconds. For each task, show: ID, repo, title (truncated), status icon, elapsed time, cost (if terminal). Use ANSI `\x1b[{n}A` to overwrite previous lines (same technique as `dashboard.ts`).
6. **Exit**: When all tasks reach terminal state (`done`, `failed`, `completed`, `review`), print summary line and exit.

## Constraints

- Capped by `min(N, max_concurrent, budget headroom)`
- Budget check: sum of `estimated_cost` for selected tasks vs remaining weekly budget
- No backfill — fixed set of N tasks, wait for all to finish
- `--batch` incompatible with `--repo` and explicit task IDs

## Status display

- ANSI cursor-up to overwrite previous render (like dashboard.ts)
- Columns: task ID, repo, title (truncated), status icon + label, elapsed time, cost
- Summary line: `N running · N done · N failed · $X.XX total`
- Poll interval: 3 seconds
- Ctrl+C handler: clear interval, print detach message, exit 0

## What's NOT included

- No backfill (dispatching new tasks as slots free up)
- No `--repo` scoping for batch mode
- No daemon/continuous drain mode
