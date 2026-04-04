# Session Summary: W-065

## Summary

Implemented an issue-status poller that periodically checks GitHub for closed issues and updates the corresponding local task status to `closed`. This closes the sync gap where GitHub issue closures (manual, merged PR, or @claude) were never reflected in the Grove task database.

The poller follows the same architectural pattern as the existing PR poller: a start/stop module with an interval-based poll loop, wired into the broker startup/shutdown lifecycle. It batches API calls by repository to minimize `gh` CLI invocations.

## Changes Made

### `src/shared/github.ts`
- Added `ghIssueView()` — fetch a single issue by number
- Added `ghIssueStatuses()` — batch-fetch issue states for a list of issue numbers within a repo (groups results from `ghIssueList`)

### `src/broker/db.ts`
- Added `tasksWithOpenIssues()` — query for tasks with a non-null `github_issue` and non-terminal status (`draft`, `queued`, `active`), joined to their tree for the GitHub repo URL

### `src/broker/issue-poller.ts` — NEW
- `startIssuePoller(db)` — polls every 5 minutes, groups tasks by repo, calls `ghIssueStatuses`, marks closed issues as `closed` with `completed_at`, emits `task:status` bus event
- `stopIssuePoller()` — clears the interval

### `src/broker/index.ts`
- Wired `startIssuePoller(db)` at broker startup (after PR poller)
- Wired `stopIssuePoller()` at broker shutdown

### `tests/broker/issue-poller.test.ts` — NEW
- 5 tests covering `tasksWithOpenIssues()`: non-terminal statuses returned, terminal statuses excluded, null github_issue excluded, trees without github excluded, multi-repo grouping

## Files Modified
- `src/shared/github.ts` — ghIssueView + ghIssueStatuses helpers
- `src/broker/db.ts` — tasksWithOpenIssues query
- `src/broker/issue-poller.ts` — new poller module
- `src/broker/index.ts` — wiring
- `tests/broker/issue-poller.test.ts` — new test file

## Next Steps
- None — feature is complete as specified in issue #156
