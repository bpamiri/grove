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
Implement the task. Commit your changes with conventional commit messages.

### Git Branch
Work on branch: `grove/W-078-auto-rebase-worktree-on-main-before-eval`
Commit message format: conventional commits — `feat: (W-078) description`, `fix: (W-078) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Previous Session
# Session Summary: W-078

## Summary

Explored the Grove step engine, worker, worktree, and config systems to understand how pipeline evaluation steps work. Created a detailed implementation plan for auto-rebasing worktrees onto main before read-only (evaluation) steps.

### Key Design Decisions

- **Trigger on `sandbox: "read-only"` steps** — These are the evaluation/review gates where stale worktrees cause phantom test failures. Read-write steps (implement, merge) don't need rebase because they produce code or use GitHub's merge mechanism.
- **`rebaseOnMain()` utility in worktree.ts** — New function that fetches origin, rebases, and on conflict aborts + returns conflicting file list. Uses the existing `git()` helper and `resolveDefaultBranch()`.
- **Hook in `executeStep()` before worker spawn** — After plugin pre-hook, before `switch (step.type)`, gated by `settingsGet("rebase_before_eval")` and `task.worktree_path` presence.
- **Conflict = failure, not fatal** — Routes through `on_failure` path (back to implement), giving the worker a retry opportunity to resolve conflicts.
- **Non-fatal catch for unexpected errors** — If rebaseOnMain throws, logs the error but proceeds with evaluation on the potentially stale base.
- **`rebase_before_eval: true` default** in `SettingsConfig` — Can be disabled in grove.yaml `settings:`.

## Files Modified

- `docs/superpowers/plans/2026-04-04-auto-rebase-before-eval.md` — Implementation plan (4 tasks)

## Next Steps

- Execute the plan (4 tasks):
  1. Add `rebase_before_eval` to `SettingsConfig` in types.ts
  2. Add `rebaseOnMain()` to worktree.ts with unit tests
  3. Hook rebase into `executeStep()` in step-engine.ts
  4. Add step engine integration tests


### Files Already Modified
.claude/CLAUDE.md
.grove/session-summary.md
package.json
src/broker/orchestrator-feedback.ts
src/broker/server.ts
src/shared/types.ts
tests/broker/orchestrator-feedback.test.ts
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
- Do NOT push to remote — Grove handles that
