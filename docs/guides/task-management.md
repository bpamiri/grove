# Task Management

## Task Lifecycle

Tasks progress through statuses: `draft` → `queued` → `active` → `completed` or `failed`.

```
draft ──dispatch──▶ queued ──worker picks up──▶ active ──gates pass──▶ completed
                                                  │
                                                  ├──gate fail──▶ retry (back to active)
                                                  │
                                                  └──budget/crash──▶ failed
```

Create tasks via the web GUI, CLI, or orchestrator chat:

```bash
grove task add "Add auth middleware" --tree api-server
```

Tasks start as `draft`. Dispatch them manually (GUI button or CLI) or let the orchestrator auto-dispatch when ready.

---

## Task Dependencies

Tasks can declare dependencies on other tasks using the `depends_on` field. A dependent task will not be dispatched until all its dependencies have completed.

### Setting Dependencies

In the web GUI, set dependencies when creating or editing a task. Via the API:

```json
POST /api/tasks
{
  "title": "Deploy frontend",
  "tree_id": "frontend",
  "depends_on": "W-041,W-042"
}
```

The `depends_on` field is a comma-separated list of task IDs. The dispatch system checks all listed tasks — if any are incomplete, the dependent task stays queued.

### Cascade Dispatch

When a task completes (its PR is merged), Grove automatically unblocks any tasks that depend on it. The step engine listens for `merge:completed` events and re-checks the dependency list of all waiting tasks, dispatching newly unblocked ones.

This means you can set up chains:

```
Task A (no deps) ──▶ Task B (depends_on: A) ──▶ Task C (depends_on: B)
```

Task B starts automatically when A's PR merges. Task C starts when B's PR merges.

### Dependency Rules

- Dependencies are checked at dispatch time and when any task completes
- A task with unmet dependencies stays in `queued` status
- Circular dependencies are not detected — avoid creating them
- Dependencies reference task IDs (e.g., `W-041`), not task titles

---

## Batch Dispatch

When you have multiple draft tasks for the same tree, batch dispatch analyzes them for potential file conflicts and groups them into execution waves that can run in parallel without merge conflicts.

This solves the **rebase-conflict loop** — when multiple workers edit the same files concurrently, their branches conflict during merge, triggering costly retry cycles.

### How It Works

1. **File prediction** — Grove extracts file references and identifiers from each task's title and description, then matches them against the actual repo file tree
2. **Overlap matrix** — Pairwise comparison finds which tasks share predicted files
3. **Wave derivation** — Greedy graph coloring assigns tasks to waves where no two overlapping tasks share a wave
4. **Dependency wiring** — Wave N+1 tasks get `depends_on` set to wave N task IDs

### Using Batch Dispatch

**Web GUI:** Select a tree with 2+ draft tasks. Click the **Plan Batch** button (appears in the task list header). The batch planner shows:
- Per-task file predictions with confidence (high/medium/low)
- Overlap matrix highlighting shared files
- Execution waves with dispatch buttons

Dispatch wave by wave. Wave 1 runs immediately; wave 2 runs after wave 1 completes (via dependency wiring).

**CLI:**

```bash
grove batch api-server           # Analyze and show plan
grove batch api-server --run     # Analyze and auto-dispatch wave 1
grove batch api-server --json    # Output plan as JSON (for scripting)
```

### Prediction Accuracy

The current analyzer uses heuristic file prediction — it matches identifiers in task descriptions against repo filenames. Confidence levels:

| Confidence | Meaning |
|-----------|---------|
| **high** | Exact file path found in description |
| **medium** | Identifier matches a filename (e.g., "AuthService" → `auth-service.ts`) |
| **low** | Substring or normalized match |

Tasks with no predicted files are assigned to wave 1 (assumed independent).

---

## Resume at Step

If a task fails or stalls mid-pipeline, you can resume it at any step — not just the one that failed.

**Web GUI:** Open a failed task's detail view. Click **Resume** and optionally select a step to resume from.

**API:**

```json
POST /api/tasks/:id/resume
{ "step": "implement" }
```

If no `step` is provided, the task resumes at its current step. The resume operation:

1. Validates the step exists in the task's path definition
2. Kills any active worker still running for the task
3. Resets the retry count for the step
4. Re-dispatches the task

This is useful when a task failed due to a transient issue (network, API rate limit) or when you want to re-run implementation after manually fixing something in the worktree.

---

## Cancel and Pause

### Cancel a Task

Canceling stops a running task immediately and marks it `failed`.

**Web GUI:** Click the **Cancel** button on an active task card.

**WebSocket:**

```json
{ "type": "action", "action": "cancel_task", "taskId": "W-042" }
```

The cancel action sets the task status to `failed`, kills the worker process, and releases the worker slot.

### Pause a Task

Pausing stops the current worker but preserves the task's state so it can be resumed later. The task keeps its worktree and branch intact.

A paused task has `paused: 1` in the database. Resume it with the Resume feature described above.

### When to Use Each

| Action | Worker killed | Worktree kept | Can resume | Use when |
|--------|:---:|:---:|:---:|----------|
| **Cancel** | Yes | Yes | Via retry | Task is wrong or no longer needed |
| **Pause** | Yes | Yes | Yes | Task is burning budget, needs manual intervention |
| **Resume** | N/A | Yes | N/A | Continue a paused/failed task |
| **Retry** | N/A | Yes | N/A | Re-run a failed task from scratch (increments retry count) |
