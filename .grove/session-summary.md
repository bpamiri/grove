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
