# Configurable Pipeline State Machine

**Date:** 2026-03-27
**Status:** Approved design, pending implementation

## Problem

Grove's pipeline steps are currently labels only — the execution flow is hardcoded as `worker → evaluator → merge manager` regardless of the configured path. Task statuses (`planned`, `ready`, `running`, `done`, `evaluating`, `merged`, etc.) conflate lifecycle state with pipeline position, making the UI confusing and custom paths impossible.

## Goals

1. Task status reflects lifecycle state (draft/queued/active/paused/completed/failed), not pipeline position.
2. Pipeline steps are driven from path configuration in `grove.yaml`, not hardcoded.
3. Each step can have its own system prompt, handler type, and success/failure branching.
4. Paused is a modifier on the current step, not its own status.
5. Default paths ship with minimal prompts; users customize only when defaults are insufficient.

## Non-Goals

- Custom handler types (shell commands, webhooks) — future work if needed.
- Arbitrary conditional transitions based on criteria beyond success/failure.
- Per-step cost budgets.

---

## Data Model

### Task Table Changes

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `status` | TEXT | `'draft'` | Lifecycle state: `draft`, `queued`, `active`, `completed`, `failed` |
| `current_step` | TEXT | NULL | Current pipeline step ID (e.g., `"implement"`) or terminal (`"$done"`, `"$fail"`) |
| `step_index` | INTEGER | 0 | Position in the path's step array |
| `paused` | INTEGER | 0 | Boolean flag — overlays on current step |

### Status Values (fixed, not configurable)

| Status | Meaning |
|--------|---------|
| `draft` | Created, not dispatched. UI shows Dispatch button. |
| `queued` | Dispatched, waiting for worker slot. `current_step` set to first step. |
| `active` | A step handler is executing. `current_step` identifies which step. When `paused` flag is true, the step is suspended but status remains `active`. |
| `completed` | Pipeline finished. `current_step` = `$done`. |
| `failed` | Retries exhausted. `current_step` = `$fail`. |

Note: `paused` is NOT a status value — it is a boolean flag (`paused` column) that overlays on `active`. This keeps the status enum to 5 values.

### PipelineStep Type (internal, fully normalized)

```typescript
interface PipelineStep {
  id: string;           // "plan", "implement", "evaluate", "merge", etc.
  type: "worker" | "gate" | "merge";
  prompt?: string;      // Injected into worker CLAUDE.md overlay
  on_success: string;   // Next step ID, or "$done"
  on_failure: string;   // Step ID to branch to, or "$fail"
  max_retries?: number; // Per-step retry limit (default: task-level)
  label?: string;       // Display label (default: capitalize id)
}
```

Terminal sentinels `$done` and `$fail` are prefixed with `$` to avoid collision with step IDs.

---

## Config Format

### YAML (what users write)

Steps are an ordered array. Each entry can be a string shorthand or a full object. Transitions default to "advance to next step" on success and "$fail" on failure.

```yaml
paths:
  development:
    description: Standard dev workflow with QA
    steps:
      - plan
      - implement
      - evaluate:
          type: gate
          on_failure: implement
      - merge:
          type: merge
```

### Fully explicit form (what AI agents generate)

```yaml
paths:
  development:
    description: Standard dev workflow with QA
    steps:
      - id: plan
        type: worker
        prompt: >
          Analyze the task requirements. Identify which files need
          changes and outline your implementation approach.
        on_success: implement
        on_failure: $fail
      - id: implement
        type: worker
        prompt: >
          Implement the task. Commit your changes with conventional
          commit messages.
        on_success: evaluate
        on_failure: $fail
      - id: evaluate
        type: gate
        on_success: merge
        on_failure: implement
      - id: merge
        type: merge
        on_success: $done
        on_failure: $fail
```

Both forms produce identical internal representations after normalization.

### Normalization Rules

Applied at config load time by a `normalizePath()` function:

1. String `"plan"` expands to `{ id: "plan", type: <inferred>, on_success: <next>, on_failure: "$fail" }`.
2. Object `evaluate: { type: gate }` fills in defaults for missing fields.
3. `on_success` defaults to the next step in the array, or `$done` for the last step.
4. `on_failure` defaults to `$fail`.
5. `type` defaults to `worker` unless the step ID matches a known built-in (see below).
6. `label` defaults to capitalized `id`.

### Type Inference from Step ID

Only applied when `type` is omitted:

| Step ID | Inferred Type |
|---------|---------------|
| `merge` | `merge` |
| `evaluate` | `gate` |
| Everything else | `worker` |

Explicit `type` always takes precedence.

---

## Handler Types

Three built-in handler types. Each is mapped to existing Grove subsystems.

### `worker`

Spawns a Claude Code session in the task's worktree. The step's `prompt` field is injected into the CLAUDE.md overlay alongside the existing task context (title, description, branch, session summary, etc.).

- Success: worker process exits with code 0.
- Failure: worker exits with non-zero code or crashes.

### `gate`

Runs quality checks synchronously (no Claude session). Uses the existing evaluator logic: commits check, test command, lint command, diff size.

- Success: all hard gates pass.
- Failure: any hard gate fails.

Gate configuration (test_command, lint_command, etc.) remains on the tree's quality_gates config, not on the step.

### `merge`

Runs the PR lifecycle: push branch → create/reuse PR → watch CI → merge on green.

- Success: PR merged.
- Failure: CI fails or merge blocked.

---

## Step Engine

New module `src/engine/step-engine.ts` replaces the current `pipeline.ts` event wiring. Single place that knows how to run steps and handle transitions.

### Interface

```typescript
/** Start the pipeline for a newly dispatched task */
function startPipeline(task: Task, tree: Tree, db: Database): void

/** Called by handlers when a step finishes */
function onStepComplete(taskId: string, outcome: "success" | "failure", context?: string): void
```

### Execution Flow

`startPipeline`:
1. Resolve path config from `task.path_name`.
2. Normalize steps via `normalizePath()`.
3. Set `current_step` to first step, `step_index` to 0, `status` to `active`.
4. Call `executeStep()`.

`executeStep`:
1. Look up `step.type`.
2. Dispatch to handler:
   - `worker` → `spawnWorker()` with step prompt injected.
   - `gate` → `evaluate()`.
   - `merge` → `queueMerge()`.

`onStepComplete`:
1. Look up current step's `on_success` or `on_failure` based on outcome.
2. Resolve transition target:
   - Step ID → call `executeStep(findStep(target))`, update `current_step` and `step_index`.
   - `$done` → set `status = "completed"`, `current_step = "$done"`.
   - `$fail` → check retry budget. If retries remain, re-enter current step. If exhausted, set `status = "failed"`, `current_step = "$fail"`.

### Retry Logic

Consolidated in the step engine. Every step has a retry budget:
- Per-step `max_retries` if defined on the step.
- Otherwise, task-level `max_retries`.

When `on_failure` points to the same or an earlier step (branching back), this counts as a retry. The engine tracks retries and stops when budget is exhausted.

### What Changes in Existing Handlers

| Handler | Current trigger | New trigger |
|---------|----------------|-------------|
| Worker (`worker.ts`) | `dispatch.ts` calls `spawnWorker()` directly | Step engine calls `spawnWorker()` with step prompt |
| Evaluator (`evaluator.ts`) | `pipeline.ts` listens for `worker:ended` | Step engine calls `evaluate()` when step type is `gate` |
| Merge (`manager.ts`) | `pipeline.ts` calls `queueMerge()` after eval pass | Step engine calls `queueMerge()` when step type is `merge` |

Handlers call `onStepComplete()` when done instead of directly setting task status.

---

## Pipeline UI

### Rendering Logic

The Pipeline component becomes fully data-driven:

1. Fetch path definitions from `GET /api/paths` (cached on load).
2. For a task, look up `paths[task.path_name].steps`.
3. Render each step with visual state based on `task.current_step`, `task.step_index`, `task.paused`, and `task.status`.

### Step Visual States

| Condition | Appearance |
|-----------|------------|
| Step index < task's failed/current step index AND task not branched back to this step | Green checkmark |
| Step is `current_step` AND status is `active` | Blue with dot, glow |
| Step is `current_step` AND `paused` is true | Amber with pause icon |
| Step is `current_step` AND status is `failed` | Red with X |
| Step index > current step index | Gray dot |
| `current_step` is `$done` | All steps green |
| `current_step` is `$fail` | Steps up to failed step green, failed step red, rest gray |

When the pipeline branches backward (e.g., evaluate fails → back to implement), the current_step matching determines rendering, not just position. A step that previously completed but is now the current step again shows as active, not done.

### Status Badge on Task Cards

| Condition | Badge |
|-----------|-------|
| `status = draft` | Gray "Draft" |
| `status = queued` | Cyan "Queued" |
| `status = active, paused = false` | Blue, shows current step label (e.g., "Implementing") |
| `status = active, paused = true` | Amber "Paused" with step label |
| `status = completed` | Green "Completed" |
| `status = failed` | Red "Failed" |

---

## API Changes

### Task Response (updated fields)

```json
{
  "id": "W-002",
  "status": "active",
  "current_step": "implement",
  "step_index": 1,
  "paused": false,
  "path_name": "development"
}
```

### GET /api/paths (new)

Returns all paths with fully normalized steps. Prompts excluded (server-side only).

```json
{
  "development": {
    "description": "Standard dev workflow with QA",
    "steps": [
      { "id": "plan", "type": "worker", "label": "Plan", "on_success": "implement", "on_failure": "$fail" },
      { "id": "implement", "type": "worker", "label": "Implement", "on_success": "evaluate", "on_failure": "$fail" },
      { "id": "evaluate", "type": "gate", "label": "Evaluate", "on_success": "merge", "on_failure": "implement" },
      { "id": "merge", "type": "merge", "label": "Merge", "on_success": "$done", "on_failure": "$fail" }
    ]
  }
}
```

---

## Default Paths

Three built-in paths with minimal default prompts. Users override per-step in `grove.yaml`.

### development

| Step | Type | Prompt | on_failure |
|------|------|--------|------------|
| plan | worker | Analyze the task requirements. Identify which files need changes and outline your implementation approach. | $fail |
| implement | worker | Implement the task. Commit your changes with conventional commit messages. | $fail |
| evaluate | gate | *(runs quality checks)* | implement |
| merge | merge | *(PR lifecycle)* | $fail |

### research

| Step | Type | Prompt | on_success |
|------|------|--------|------------|
| plan | worker | Analyze what needs to be researched. Identify sources and outline your approach. | research |
| research | worker | Conduct the research. Document findings as you go. | report |
| report | worker | Write a clear summary report of your findings in .grove/report.md in the worktree. | $done |

### content

| Step | Type | Prompt | on_failure |
|------|------|--------|------------|
| plan | worker | Outline the content structure, audience, and key points. | $fail |
| implement | worker | Write the content following the plan. | $fail |
| evaluate | gate | *(runs quality checks)* | implement |
| publish | merge | *(PR lifecycle)* | $fail |

---

## Migration

### DB Migration SQL

```sql
ALTER TABLE tasks ADD COLUMN current_step TEXT;
ALTER TABLE tasks ADD COLUMN step_index INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN paused INTEGER DEFAULT 0;

UPDATE tasks SET status = 'draft', current_step = NULL WHERE status = 'planned';
UPDATE tasks SET status = 'queued', current_step = 'plan' WHERE status = 'ready';
UPDATE tasks SET status = 'active', current_step = 'implement' WHERE status = 'running';
UPDATE tasks SET status = 'active', current_step = 'evaluate' WHERE status = 'evaluating';
UPDATE tasks SET status = 'active', current_step = 'implement', paused = 1 WHERE status = 'paused';
UPDATE tasks SET status = 'completed', current_step = '$done' WHERE status IN ('merged', 'completed', 'done');
UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE status IN ('failed', 'ci_failed');
```

### Rollout Order

1. Schema + types — add columns, update `TaskStatus` enum, add `PipelineStep` type.
2. Config normalization — `normalizePath()` function that expands shorthand to full `PipelineStep[]`.
3. Step engine — new `src/engine/step-engine.ts`, replaces `pipeline.ts` wiring.
4. Update handlers — worker/evaluator/merge call `onStepComplete()` instead of directly setting status.
5. API changes — add `GET /api/paths`, include new fields in task responses.
6. Frontend — update Pipeline component, task list status badges, task detail.
7. Default prompts — add to `DEFAULT_PATHS`, wire into worker's CLAUDE.md overlay.

Each step builds on the previous but is independently testable.
