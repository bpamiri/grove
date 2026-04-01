# Custom Paths

Paths define the pipeline a task follows from creation to completion. Grove ships with built-in paths (`development`, `research`, `content`, and `adversarial`), and you can define custom ones in `grove.yaml`.

---

## Anatomy of a Path

A path is an ordered list of steps. Each step has a type that determines what happens when the step executes:

| Step Type | What it does |
|-----------|-------------|
| `worker` | Spawns a Claude Code session to do work (plan, implement, research, etc.) |
| `gate` | Runs quality checks (tests, lint, diff size, commit format) |
| `merge` | Pushes the branch, creates a PR, monitors CI, auto-merges |
| `review` | Spawns an adversarial reviewer session that critiques a plan and writes a verdict |
| `verdict` | Waits for a maintainer decision on an external PR (approve/reject/revise) |

Steps connect via transitions: `on_success` (what happens when the step passes) and `on_failure` (what happens when it fails).

---

## Defining a Path

### Full Object Syntax

```yaml
paths:
  my-workflow:
    description: "Custom workflow with review step"
    steps:
      - id: plan
        type: worker
        prompt: "Analyze the task and create an implementation plan."
      - id: implement
        type: worker
        prompt: "Implement the plan. Write tests. Commit with conventional commits."
      - id: evaluate
        type: gate
        on_failure: implement
      - id: merge
        type: merge
```

### String Shorthand

For common step names, you can use bare strings. Grove expands them to full step objects with inferred types and default transitions:

```yaml
paths:
  quick:
    description: "Skip planning, go straight to implementation"
    steps: [implement, evaluate, merge]
```

### Type Inference

When using string shorthand, Grove infers the step type from the name:

| Step name | Inferred type |
|-----------|---------------|
| `merge` | `merge` |
| `evaluate` | `gate` |
| `ci-check` | `gate` |
| `review` | `review` |
| `verdict` | `verdict` |
| Everything else | `worker` |

So `steps: [plan, implement, evaluate, merge]` produces: worker → worker → gate → merge.

---

## Step Fields

| Field | Required | Description |
|-------|:--------:|-------------|
| `id` | Yes | Unique identifier within the path. Used for transition targets. |
| `type` | No | `worker`, `gate`, `merge`, `review`, or `verdict`. Inferred from `id` if omitted. |
| `prompt` | No | Instructions passed to the Claude Code worker. Only used for `worker` steps. |
| `label` | No | Display name shown in the GUI pipeline indicator. Auto-generated from `id` (capitalized) if omitted. |
| `on_success` | No | Step ID to transition to on success. Defaults to the next step, or `$done` for the last step. |
| `on_failure` | No | Step ID to transition to on failure. See default behavior below. |
| `max_retries` | No | Override the global `max_retries` for this specific step. |

---

## Default Transitions

When you omit `on_success` or `on_failure`, Grove fills in sensible defaults:

**`on_success`** — Always defaults to the next step in the list. The last step defaults to `$done` (task completes successfully).

**`on_failure`** — Depends on the step type:

| Step type | Default `on_failure` |
|-----------|---------------------|
| `gate` | Loops back to the nearest preceding `worker` step |
| `review` | Loops back to the nearest preceding `worker` step |
| `worker` | `$fail` (task fails) |
| `merge` | `$fail` (task fails) |
| `verdict` | `$fail` (task fails) |

The gate-to-worker loop is the core retry mechanism: when tests fail, the evaluator sends the task back to the worker with feedback, and the worker gets another chance to fix it.

### Terminal Transitions

Two special transition targets:

| Target | Meaning |
|--------|---------|
| `$done` | Task completed successfully |
| `$fail` | Task failed (after exhausting retries) |

---

## Retry Behavior

When a step fails and transitions back to a retryable step:

1. The retry count increments
2. If retries < `max_retries`, the step re-executes
3. If retries >= `max_retries`, the task transitions to `$fail`

The default `max_retries` is set in `settings.max_retries` (default: 2). You can override per-step:

```yaml
steps:
  - id: implement
    type: worker
    prompt: "..."
    max_retries: 4    # Allow more attempts for this step
  - id: evaluate
    type: gate
    on_failure: implement
```

---

## Built-in Paths

### `development`

The standard workflow for code changes:

```
plan ──▶ implement ──▶ evaluate ──▶ merge ──▶ $done
                         │
                         └── fail ──▶ implement (retry)
```

- **plan**: Worker analyzes requirements and outlines approach
- **implement**: Worker writes code, tests, commits
- **evaluate**: Gate runs tests, lint, diff size checks
- **merge**: Push branch, create PR, watch CI, auto-merge

### `research`

For tasks that produce information, not code:

```
plan ──▶ research ──▶ report ──▶ $done
```

All three steps are `worker` type — no gates or merges.

### `content`

For documentation and content creation:

```
plan ──▶ implement ──▶ evaluate ──▶ publish ──▶ $done
                         │
                         └── fail ──▶ implement (retry)
```

Similar to `development` but uses a `publish` step instead of `merge` — semantically indicating the output is content rather than code.

### `adversarial`

For tasks requiring rigorous plan review before implementation:

```
plan ──▶ review ──▶ implement ──▶ evaluate ──▶ merge ──▶ $done
  ▲        │                        │
  └── reject                        └── fail ──▶ implement (retry)
```

- **plan**: Worker creates a detailed implementation plan
- **review**: Adversarial reviewer critiques the plan (up to 3 review rounds)
- **implement**: Worker implements the approved plan
- **evaluate**: Gate runs tests, lint, diff size checks
- **merge**: Push, PR, CI, auto-merge

---

## Assigning Paths to Tasks

Tasks use the `development` path by default. Specify a different path when creating a task:

**CLI:**
```bash
grove task add "Research auth patterns" --path research
```

**API:**
```json
POST /api/tasks
{ "title": "Research auth patterns", "path_name": "research" }
```

**Web GUI:** Select the path from the dropdown when creating a task.

---

## Plugin Hooks in Step Execution

Plugins can intercept step execution via hooks:

- **`step:pre`** — fires before a step executes. The hook can block execution or modify step parameters (e.g., inject extra prompt context).
- **`step:post`** — fires after each step completes, receiving the step result. Useful for logging, notifications, or triggering side effects.
- **`gate:custom`** — extends the gate evaluation pipeline. Custom gate plugins receive the worker output and return a pass/fail verdict, composing with built-in gate checks.

---

## Seed-Aware Behavior

When a task has a seed spec (from a brainstorming session), the step engine skips the `plan` step — the seed replaces it. The worker receives the seed spec as context when executing the first non-plan step.

This means a seeded task on the `development` path effectively runs: implement → evaluate → merge.

---

## Example: Review-Heavy Workflow

```yaml
paths:
  reviewed:
    description: "Implementation with mandatory code review"
    steps:
      - id: plan
        type: worker
        prompt: "Create a detailed implementation plan with file list."
      - id: implement
        type: worker
        prompt: "Implement the plan. Follow existing patterns."
      - id: evaluate
        type: gate
        on_failure: implement
      - id: review
        type: worker
        prompt: "Review the implementation for security, performance, and correctness. Suggest fixes if needed."
      - id: final-check
        type: gate
        on_failure: review
      - id: merge
        type: merge
```

This adds a review step after the initial gate — a separate Claude session reviews the code before it's allowed to merge.
