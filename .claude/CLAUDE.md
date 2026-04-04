# Task: W-078
## Auto-rebase worktree on main before evaluate step

### Description
## Problem
When multiple tasks run in parallel (e.g., wave 1 with 5 concurrent workers), tasks that finish last have stale worktrees. Earlier tasks have already merged to main, but the late-finishing worktree doesn't know about those changes. This causes:
1. Phantom test failures from missing schema changes or deleted imports
2. Evaluate gates rejecting valid work over stale-base issues
3. Unnecessary implement→evaluate retry loops wasting time and budget

Observed with W-068: its worktree was branched before W-069, W-072, and W-073 merged. The evaluate step saw the worker "deleting" files that other PRs had added.

## Scope
Add an automatic rebase-on-main step in the step engine before running the evaluate gate:

1. **Before evaluate starts:** fetch `origin/main` and rebase the task branch onto it in the worktree.
2. **If rebase succeeds cleanly:** proceed to evaluate as normal.
3. **If rebase has conflicts:** mark the conflicts in the task events, fail the evaluate step with a clear error ("rebase conflict with main"), and surface the conflicting files so the implement step can resolve them on retry.
4. **Configurable:** add a `rebase_before_eval: true` (default) setting in grove.yaml `settings:` so it can be disabled if needed.

## Key Files
- `src/engine/step-engine.ts` — step transition logic, pre-step hooks
- `src/agents/worker.ts` — worktree management
- `src/broker/dispatch.ts` — task dispatch (may need to pass base branch info)

## Notes
- This is the evaluate-specific case. A more general "rebase before each step" might be overkill — evaluate is where stale bases actually cause problems because it runs tests.
- The rebase should be a fast, non-worker operation (just git commands) — no need to spawn a Claude agent for it.

### Workflow
This task follows the **development** path.

### Strategy
You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.

### Step Instructions
Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.

### Git Branch
Work on branch: `grove/W-078-auto-rebase-worktree-on-main-before-eval`
Commit message format: conventional commits — `feat: (W-078) description`, `fix: (W-078) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Checkpoint — Resuming from prior session
- **Step:** evaluate (index 2)
- **Last commit:** fd17d967b847410f6903fc36052ff5e6763066ac
- **Files modified:** .claude/CLAUDE.md
- **Summary:** # Session Summary: W-078

## Summary

Implemented auto-rebase of worktrees onto main before read-only evaluation steps. This prevents phantom test failures caused by stale worktrees when multiple tasks run in parallel and earlier tasks merge to main before later tasks reach their evaluation gate.

### Changes Made

1. **`rebase_before_eval` setting** — Added to `SettingsConfig` interface and `DEFAULT_SETTINGS` (default: `true`), configurable in grove.yaml `settings:`.

2. **`rebaseOnMain()` utility** — New exported function in `worktree.ts` that fetches origin and rebases the task branch onto the default branch. On conflict, aborts the rebase and returns conflicting file names. Also exported `resolveDefaultBranch` (previously private).

3. **Step engine hook** — In `executeStep()`, before spawning a worker for `sandbox: "read-only"` steps, the engine now calls `rebaseOnMain()`. On success, logs a `rebase_completed` event. On conflict, logs `rebase_conflict` with file names and fails via `on_failure` (typically back to implement). On unexpected errors, logs `rebase_failed` but proceeds non-fatally.

4. **Tests** — 4 unit tests for `rebaseOnMain()` (clean rebase, conflicts, custom defaultBranch, no-op) and 5 integration tests for the step engine hook (calls before read-only, skips read-write, respects disabled setting, handles conflicts, skips null worktree_path).

## Files Modified

- `src/shared/types.ts` — Added `rebase_before_eval` to `SettingsConfig` + `DEFAULT_SETTINGS`
- `src/shared/worktree.ts` — Added `rebaseOnMain()`, `RebaseResult` interface, exported `resolveDefaultBranch`
- `src/engine/step-engine.ts` — Added rebase logic in `executeStep()` before worker spawn
- `tests/shared/worktree-rebase.test.ts` — New: 4 unit tests for `rebaseOnMain()`
- `tests/engine/step-engine.test.ts` — Added 5 integration tests for rebase-before-eval behavior
- `docs/superpowers/plans/2026-04-04-auto-rebase-before-eval.md` — Implementation plan (from previous session)

## Next Steps

None — implementation is complete. All 387 core tests pass (0 failures).

- **Cost so far:** $0.00

Continue from where you left off. The WIP commit contains your in-progress work.
Do NOT repeat work that's already committed.

### Previous Session
# Session Summary: W-078

## Summary

Implemented auto-rebase of worktrees onto main before read-only evaluation steps. This prevents phantom test failures caused by stale worktrees when multiple tasks run in parallel and earlier tasks merge to main before later tasks reach their evaluation gate.

### Changes Made

1. **`rebase_before_eval` setting** — Added to `SettingsConfig` interface and `DEFAULT_SETTINGS` (default: `true`), configurable in grove.yaml `settings:`.

2. **`rebaseOnMain()` utility** — New exported function in `worktree.ts` that fetches origin and rebases the task branch onto the default branch. On conflict, aborts the rebase and returns conflicting file names. Also exported `resolveDefaultBranch` (previously private).

3. **Step engine hook** — In `executeStep()`, before spawning a worker for `sandbox: "read-only"` steps, the engine now calls `rebaseOnMain()`. On success, logs a `rebase_completed` event. On conflict, logs `rebase_conflict` with file names and fails via `on_failure` (typically back to implement). On unexpected errors, logs `rebase_failed` but proceeds non-fatally.

4. **Tests** — 4 unit tests for `rebaseOnMain()` (clean rebase, conflicts, custom defaultBranch, no-op) and 5 integration tests for the step engine hook (calls before read-only, skips read-write, respects disabled setting, handles conflicts, skips null worktree_path).

## Files Modified

- `src/shared/types.ts` — Added `rebase_before_eval` to `SettingsConfig` + `DEFAULT_SETTINGS`
- `src/shared/worktree.ts` — Added `rebaseOnMain()`, `RebaseResult` interface, exported `resolveDefaultBranch`
- `src/engine/step-engine.ts` — Added rebase logic in `executeStep()` before worker spawn
- `tests/shared/worktree-rebase.test.ts` — New: 4 unit tests for `rebaseOnMain()`
- `tests/engine/step-engine.test.ts` — Added 5 integration tests for rebase-before-eval behavior
- `docs/superpowers/plans/2026-04-04-auto-rebase-before-eval.md` — Implementation plan (from previous session)

## Next Steps

None — implementation is complete. All 387 core tests pass (0 failures).


### Files Already Modified
.claude/CLAUDE.md
.grove/session-summary.md
docs/superpowers/plans/2026-04-04-auto-rebase-before-eval.md
package.json
src/broker/orchestrator-feedback.ts
src/broker/server.ts
src/engine/step-engine.ts
src/shared/types.ts
src/shared/worktree.ts
tests/broker/orchestrator-feedback.test.ts
tests/engine/step-engine.test.ts
tests/shared/worktree-rebase.test.ts
web/src/App.tsx
web/src/components/DagEditor.tsx
web/src/components/Dashboard.tsx
web/src/components/TaskList.tsx
web/src/hooks/useAnalytics.ts

### Session Summary Instructions
Before finishing, create `.grove/session-summary.md` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains (if anything)

### Working Guidelines
- Make atomic commits: `feat: (W-078) description`, `fix: (W-078) description`
- Run tests if available before marking done
- Write the session summary file before finishing
