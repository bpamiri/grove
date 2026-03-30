# W-032: Resume Task at Specific Pipeline Step

## Problem

After manually resolving a conflict on a task branch, there is no way to resume
the task at a specific step (e.g., `evaluate`). The existing retry endpoint
(`POST /api/tasks/:id/retry`) sets status to `queued` and re-enqueues, but
`dispatch.processQueue()` calls `startPipeline()` which always resets
`current_step` to step 0. The worktree and branch are preserved, but all
pipeline progress is lost.

## Solution

Add `resumePipeline()` to the step engine and a `POST /api/tasks/:id/resume`
REST endpoint. The dispatch module calls `resumePipeline` when a task already
has a valid `current_step`, so retries also resume correctly.

## Architecture

### 1. Step Engine (`src/engine/step-engine.ts`)

New export: `resumePipeline(task, tree, db, stepId?)`

- If `stepId` is provided, validate it exists in the task's path config,
  update `current_step` and `step_index`, then execute.
- If `stepId` is omitted, resume at `task.current_step`.
- Rejects if `current_step` is `$done`, `$fail`, or `null`.
- Sets status to `active`, emits `task:status`.
- Resets `retry_count` to 0 (fresh start at the target step).

### 2. Dispatch (`src/broker/dispatch.ts`)

In `processQueue()`, detect whether the task is a fresh dispatch or a resume:

- Fresh: `current_step` is `null` or matches the first step in the path
  → call `startPipeline()`
- Resume: `current_step` is a valid step ID (not `$done`/`$fail`)
  → call `resumePipeline()`

### 3. REST Endpoint (`src/broker/server.ts`)

`POST /api/tasks/:id/resume`

Request body (JSON):
```json
{ "step": "evaluate" }   // optional — defaults to task's current_step
```

Behavior:
1. Validate task exists and is in `failed`, `active` (paused), or `queued` state.
2. If active, stop the worker first.
3. Set `current_step` to the requested step (validated against path config).
4. Reset `retry_count` to 0.
5. Set status to `queued`, enqueue for dispatch.

Response: `{ ok: true, taskId, step, status: "queued" }`

Error cases:
- 404: Task not found
- 400: Invalid step name (not in path config)
- 400: Task in `completed` status (use retry instead? or just block)

### 4. WebSocket Action (`src/broker/server.ts`)

Add `resume_task` action to `handleWsAction()`:
```
{ type: "action", action: "resume_task", taskId, step? }
```

This calls the same logic as the REST endpoint.

### 5. Web UI (`web/src/components/TaskDetail.tsx`)

For failed or paused tasks, show a "Resume at..." control:
- Dropdown listing all pipeline steps for the task's path
- Pre-selected to `current_step`
- "Resume" button that sends the `resume_task` WebSocket action

## Testing

- `resumePipeline` with explicit step → sets correct `current_step`, `step_index`
- `resumePipeline` without step → resumes at existing `current_step`
- `resumePipeline` with invalid step → rejects
- REST endpoint validates step names
- Dispatch correctly routes to `resumePipeline` vs `startPipeline`
- Retry → resume preserves worktree, resets retry count
