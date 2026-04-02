# Session Summary: W-056

## Summary

Implemented close/archive tasks from the GUI (issue #132). Added a new `closed` terminal status, Close and Delete actions in TaskDetail, and a "closed" filter tab in the task list. Closed tasks are hidden from the default view.

## Changes Made

### Shared Types (`src/shared/types.ts`)
- Added `Closed = "closed"` to `TaskStatus` enum

### Database (`src/broker/db.ts`)
- Added `taskDelete(taskId)` method for hard-deleting tasks
- Updated `getNewlyUnblocked` to exclude `closed` tasks from dependency resolution

### Server (`src/broker/server.ts`)
- Added `close_task` WebSocket action handler — sets draft/failed tasks to `closed` status
- Added `DELETE /api/tasks/:id` REST endpoint — hard-deletes draft tasks only

### Orchestrator (`src/agents/orchestrator.ts`)
- Excluded `closed` tasks from the orchestrator's active-tasks prompt query

### Frontend — TaskDetail (`web/src/components/TaskDetail.tsx`)
- Added "Close" button (muted variant) for draft and failed tasks
- Added "Delete" button (danger variant) for draft tasks with confirmation dialog
- Extended `ActionButton` to support `muted` variant styling
- Excluded `closed` tasks from showing the Cancel button

### Frontend — App (`web/src/App.tsx`)
- Added `"closed"` to `StatusFilter` union type
- Updated `applyStatusFilter`: "all" now hides closed tasks; "closed" filter shows only closed

### Frontend — TaskList (`web/src/components/TaskList.tsx`)
- Added `closed` status color (muted zinc)
- Added "closed" to filter button bar

### Tests (`tests/broker/db-close-delete.test.ts`)
- 7 tests covering close (draft, failed, terminal state exclusion, event creation) and delete (success, not-found, isolation)

## Files Modified
- `src/shared/types.ts` — added Closed enum value
- `src/broker/db.ts` — taskDelete method, getNewlyUnblocked exclusion
- `src/broker/server.ts` — close_task WS handler, DELETE endpoint
- `src/agents/orchestrator.ts` — excluded closed from active tasks
- `web/src/App.tsx` — StatusFilter type, filter logic
- `web/src/components/TaskDetail.tsx` — Close/Delete buttons, muted variant
- `web/src/components/TaskList.tsx` — closed color, filter tab
- `tests/broker/db-close-delete.test.ts` — new test file

## Next Steps
- None — feature is complete as specified in issue #132
