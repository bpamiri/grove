# Stale Worktree Cleanup

**Issue:** #110
**Date:** 2026-03-31

## Problem

Worktree cleanup only happens after successful PR merges (`postMergeCleanup` in `merge/manager.ts`). Every other terminal state — failed tasks, abandoned tasks, deleted trees, broker crashes — leaves worktrees orphaned in `.grove/worktrees/`. These accumulate disk space and clutter `git worktree list`.

## Solution

A centralized `pruneStaleWorktrees(db)` function that identifies and removes stale worktrees, wired into three automatic hooks plus a manual CLI command.

## Core Function: `pruneStaleWorktrees(db)`

Location: `src/shared/worktree.ts`

For each tree in the DB:
1. Call `listWorktrees(treePath)` to get worktrees on disk
2. For each worktree, check task status via `db.taskGet(taskId)`
3. A worktree is **stale** if:
   - Task status is `completed` or `failed`
   - Task doesn't exist in DB (deleted tree, manual cleanup)
4. Call `cleanupWorktree(taskId, treePath)` for each stale entry
5. Return `{ pruned: PrunedEntry[], errors: string[] }`

**Not stale** (skip): tasks with status `active`, `queued`, `draft`, `paused`.

```typescript
interface PrunedEntry {
  taskId: string;
  treeId: string;
  reason: "completed" | "failed" | "orphaned";
}

interface PruneResult {
  pruned: PrunedEntry[];
  errors: string[];
}
```

## Automatic Hooks

### 1. Per-task cleanup on terminal status

In `src/engine/step-engine.ts`, when a task reaches `completed` or `failed` status in `onStepComplete`, call `cleanupWorktree(taskId, treePath)` for that specific task. This is the fast path — no scanning needed.

This supplements (not replaces) the existing `postMergeCleanup` in merge/manager.ts. The merge path handles branch deletion too; this hook only handles the worktree for non-merge terminal states (failures, retries exhausted).

### 2. Tree deletion cascade

In `src/broker/server.ts` `DELETE /api/trees/:id` endpoint, after `taskDeleteByTree` and `treeDelete`, iterate worktrees for that tree path and clean them up. Uses `listWorktrees(treePath)` + `cleanupWorktree()` for each.

### 3. Health monitor periodic sweep

In `src/monitor/health.ts`, add a `pruneStaleWorktrees(db)` call to the periodic check cycle (runs every 15s). This catches anything the per-task hooks miss — crashes, bugs, race conditions. Lightweight since `listWorktrees` is just `git worktree list --porcelain`.

## CLI: `grove cleanup`

New CLI command and API endpoint.

**API:** `POST /api/cleanup/worktrees`
- Runs `pruneStaleWorktrees(db)`
- Returns `PruneResult`

**CLI:** `grove cleanup`
- Calls the API endpoint
- Displays results

```
$ grove cleanup
✓ Pruned 4 stale worktrees
  W-032 (completed) — wheels
  W-033 (completed) — wheels
  W-041 (failed) — grove
  W-042 (completed) — grove
```

If nothing to prune:
```
$ grove cleanup
✓ No stale worktrees found
```

## Layers Modified

| Layer | File | Changes |
|-------|------|---------|
| Core | `src/shared/worktree.ts` | Add `pruneStaleWorktrees(db)` |
| Engine | `src/engine/step-engine.ts` | Add worktree cleanup on terminal task status |
| API | `src/broker/server.ts` | Add `POST /api/cleanup/worktrees`, add worktree cleanup to tree delete |
| Monitor | `src/monitor/health.ts` | Add periodic `pruneStaleWorktrees` call |
| CLI | `src/cli/commands/cleanup.ts` | New command |
| CLI | `src/cli/index.ts` | Register cleanup command |
| Help | `src/cli/commands/help.ts` | Add cleanup to help text |

## Tests

- `pruneStaleWorktrees`: completed task → pruned, failed task → pruned, active task → skipped, orphaned (no DB record) → pruned
- `cleanupWorktree` idempotency: already covered by existing `existsSync` check

## Out of Scope

- Cleaning up remote branches for failed tasks (only merge path does this today)
- Age-based cleanup (e.g., "prune worktrees older than 7 days") — can add later
- UI button for cleanup in web dashboard
