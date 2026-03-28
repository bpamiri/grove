# Configurable Pipeline State Machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the hardcoded pipeline with a configurable step engine where paths define steps, handler types, prompts, and success/failure branching.

**Architecture:** A new StepEngine module becomes the central coordinator. It reads normalized PipelineStep arrays from config, dispatches handlers (worker/gate/merge) per step, and transitions based on on_success/on_failure. Task status is reduced to 5 lifecycle values; pipeline position is tracked via current_step + step_index.

**Tech Stack:** TypeScript (Bun runtime), SQLite, React + Tailwind (Vite build)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| src/shared/types.ts | Modify | New TaskStatus enum (5 values), PipelineStep interface, updated Task interface, updated DEFAULT_PATHS |
| src/broker/schema.sql | Modify | Add current_step, step_index, paused columns; change default status |
| src/broker/db.ts | Modify | Add migration runner, update isTaskBlocked and getNewlyUnblocked status checks |
| src/engine/step-engine.ts | Create | Step execution engine: startPipeline(), onStepComplete(), executeStep() |
| src/engine/normalize.ts | Create | normalizePath() expands YAML shorthand to full PipelineStep arrays |
| src/broker/config.ts | Modify | Add configNormalizedPaths() that returns normalized paths |
| src/broker/pipeline.ts | Delete | Replaced by step-engine.ts |
| src/broker/dispatch.ts | Modify | Update status values, call startPipeline() instead of spawnWorker() directly |
| src/agents/worker.ts | Modify | Accept step prompt, call onStepComplete() on exit, update pause logic |
| src/agents/evaluator.ts | Modify | Call onStepComplete() instead of relying on event wiring |
| src/merge/manager.ts | Modify | Call onStepComplete() instead of setting status directly |
| src/shared/sandbox.ts | Modify | Add stepPrompt parameter to buildOverlay() |
| src/broker/server.ts | Modify | Add GET /api/paths, update status references, update dispatch/retry |
| web/src/hooks/useTasks.ts | Modify | Add new Task fields, update Status interface, handle task:step WS event |
| web/src/components/Pipeline.tsx | Rewrite | Data-driven rendering from path config and task state |
| web/src/components/TaskList.tsx | Modify | Update status colors/borders/filters/conditionals |
| web/src/components/TaskDetail.tsx | Modify | Update status references, pass new props to Pipeline |

---

### Task 1: Types and PipelineStep Interface

**Files:**
- Modify: src/shared/types.ts

- [ ] **Step 1: Replace TaskStatus enum**

Replace lines 7-18 with:

```typescript
export enum TaskStatus {
  Draft = "draft",
  Queued = "queued",
  Active = "active",
  Completed = "completed",
  Failed = "failed",
}
```

- [ ] **Step 2: Add PipelineStep interface**

After the QualityGatesConfig interface (after line 223), add:

```typescript
export interface PipelineStep {
  id: string;
  type: "worker" | "gate" | "merge";
  prompt?: string;
  on_success: string;
  on_failure: string;
  max_retries?: number;
  label?: string;
}

export interface NormalizedPathConfig {
  description: string;
  steps: PipelineStep[];
}
```

- [ ] **Step 3: Update PathConfig to accept mixed step formats**

Replace the PathConfig interface:

```typescript
export interface PathConfig {
  description: string;
  steps: Array<string | Record<string, any>>;
}
```

- [ ] **Step 4: Add new fields to Task interface**

Add after line 106 (status: string;):

```typescript
  current_step: string | null;
  step_index: number;
  paused: number;
```

- [ ] **Step 5: Update DEFAULT_PATHS with prompts**

Replace DEFAULT_PATHS (lines 280-293):

```typescript
export const DEFAULT_PATHS: Record<string, PathConfig> = {
  development: {
    description: "Standard dev workflow with QA",
    steps: [
      { id: "plan", type: "worker", prompt: "Analyze the task requirements. Identify which files need changes and outline your implementation approach." },
      { id: "implement", type: "worker", prompt: "Implement the task. Commit your changes with conventional commit messages." },
      { id: "evaluate", type: "gate", on_failure: "implement" },
      { id: "merge", type: "merge" },
    ],
  },
  research: {
    description: "Research task — produces a report, no code changes",
    steps: [
      { id: "plan", type: "worker", prompt: "Analyze what needs to be researched. Identify sources and outline your approach." },
      { id: "research", type: "worker", prompt: "Conduct the research. Document findings as you go." },
      { id: "report", type: "worker", prompt: "Write a clear summary report of your findings in .grove/report.md in the worktree.", on_success: "$done" },
    ],
  },
  content: {
    description: "Documentation and content creation",
    steps: [
      { id: "plan", type: "worker", prompt: "Outline the content structure, audience, and key points." },
      { id: "implement", type: "worker", prompt: "Write the content following the plan." },
      { id: "evaluate", type: "gate", on_failure: "implement" },
      { id: "publish", type: "merge" },
    ],
  },
};
```

- [ ] **Step 6: Commit**

```
git add src/shared/types.ts
git commit -m "feat: add PipelineStep type and update TaskStatus enum to 5 lifecycle values"
```

---

### Task 2: Path Normalization

**Files:**
- Create: src/engine/normalize.ts

- [ ] **Step 1: Create the normalization module**

Create src/engine/normalize.ts with these exports:

- normalizePath(config: PathConfig): NormalizedPathConfig — takes a single path config with mixed string/object steps and returns fully expanded PipelineStep array
- normalizeAllPaths(paths: Record<string, PathConfig>): Record<string, NormalizedPathConfig> — normalizes all paths
- stripPrompts(paths: Record<string, NormalizedPathConfig>): Record<string, NormalizedPathConfig> — removes prompt fields for API responses

Normalization rules:
1. String "plan" becomes { id: "plan", type: inferred, on_success: next step or $done, on_failure: "$fail" }
2. Object { evaluate: { type: "gate" } } extracts key as id, value as properties
3. Object { id: "plan", type: "worker" } uses id field directly
4. Type inference: "merge" maps to type "merge", "evaluate" maps to type "gate", everything else maps to "worker"
5. on_success defaults to next step id, or "$done" for last step
6. on_failure defaults to "$fail"
7. label defaults to capitalized id

```typescript
import type { PathConfig, PipelineStep, NormalizedPathConfig } from "../shared/types";

const TYPE_INFERENCE: Record<string, PipelineStep["type"]> = {
  merge: "merge",
  evaluate: "gate",
};

export function normalizePath(config: PathConfig): NormalizedPathConfig {
  const rawSteps = config.steps;
  const steps: PipelineStep[] = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    let step: PipelineStep;

    if (typeof raw === "string") {
      step = {
        id: raw,
        type: TYPE_INFERENCE[raw] ?? "worker",
        on_success: "",
        on_failure: "$fail",
      };
    } else if (typeof raw === "object" && raw !== null) {
      let id: string;
      let props: Record<string, any>;

      if ("id" in raw && typeof raw.id === "string") {
        id = raw.id;
        props = raw;
      } else {
        const keys = Object.keys(raw);
        id = keys[0];
        const val = raw[id];
        props = typeof val === "object" && val !== null ? { ...val } : {};
      }

      step = {
        id,
        type: props.type ?? TYPE_INFERENCE[id] ?? "worker",
        on_success: props.on_success ?? "",
        on_failure: props.on_failure ?? "$fail",
        prompt: props.prompt,
        max_retries: props.max_retries,
        label: props.label,
      };
    } else {
      continue;
    }

    if (!step.on_success) {
      step.on_success = i < rawSteps.length - 1 ? "" : "$done";
    }

    if (!step.label) {
      step.label = step.id.charAt(0).toUpperCase() + step.id.slice(1);
    }

    steps.push(step);
  }

  for (let i = 0; i < steps.length; i++) {
    if (steps[i].on_success === "") {
      steps[i].on_success = i < steps.length - 1 ? steps[i + 1].id : "$done";
    }
  }

  return { description: config.description, steps };
}

export function normalizeAllPaths(paths: Record<string, PathConfig>): Record<string, NormalizedPathConfig> {
  const result: Record<string, NormalizedPathConfig> = {};
  for (const [name, config] of Object.entries(paths)) {
    result[name] = normalizePath(config);
  }
  return result;
}

export function stripPrompts(paths: Record<string, NormalizedPathConfig>): Record<string, NormalizedPathConfig> {
  const result: Record<string, NormalizedPathConfig> = {};
  for (const [name, path] of Object.entries(paths)) {
    result[name] = {
      description: path.description,
      steps: path.steps.map(({ prompt, ...rest }) => rest),
    };
  }
  return result;
}
```

- [ ] **Step 2: Commit**

```
git add src/engine/normalize.ts
git commit -m "feat: add path normalization — expands YAML shorthand to full PipelineStep arrays"
```

---

### Task 3: Config Integration

**Files:**
- Modify: src/broker/config.ts

- [ ] **Step 1: Add imports and normalized paths exports**

Add to top of config.ts:

```typescript
import { normalizeAllPaths, stripPrompts } from "../engine/normalize";
import type { NormalizedPathConfig } from "../shared/types";
```

After configPaths() (line 89), add:

```typescript
export function configNormalizedPaths(): Record<string, NormalizedPathConfig> {
  return normalizeAllPaths(configPaths());
}

export function configNormalizedPathsForApi(): Record<string, NormalizedPathConfig> {
  return stripPrompts(configNormalizedPaths());
}
```

- [ ] **Step 2: Commit**

```
git add src/broker/config.ts
git commit -m "feat: add configNormalizedPaths for resolved pipeline step configs"
```

---

### Task 4: DB Schema Migration

**Files:**
- Modify: src/broker/schema.sql
- Modify: src/broker/db.ts

- [ ] **Step 1: Update schema.sql**

Change line 25 default from 'planned' to 'draft':

```sql
  status TEXT NOT NULL DEFAULT 'draft',
```

After line 42 (completed_at TEXT), add:

```sql
  current_step TEXT,
  step_index INTEGER DEFAULT 0,
  paused INTEGER DEFAULT 0
```

- [ ] **Step 2: Add migration logic to db.ts**

Add a migrate() method to the Database class that:
1. Checks if current_step column exists via PRAGMA table_info(tasks)
2. If not, runs ALTER TABLE to add the 3 new columns
3. Migrates existing status values:
   - planned -> draft (current_step = NULL)
   - ready -> queued (current_step = 'plan')
   - running -> active (current_step = 'implement')
   - evaluating -> active (current_step = 'evaluate')
   - paused -> active (current_step = 'implement', paused = 1)
   - merged/completed/done -> completed (current_step = '$done')
   - failed/ci_failed -> failed (current_step = '$fail')

Call this.migrate() at the end of the constructor after this.exec(schema).

- [ ] **Step 3: Update isTaskBlocked**

In db.ts line 124, change the dependency check:

```typescript
return !depTask || depTask.status !== "completed";
```

- [ ] **Step 4: Update getNewlyUnblocked**

In db.ts line 132, change the status exclusion:

```sql
AND status NOT IN ('completed', 'failed')
```

- [ ] **Step 5: Commit**

```
git add src/broker/schema.sql src/broker/db.ts
git commit -m "feat: add current_step, step_index, paused columns with migration for existing data"
```

---

### Task 5: Step Engine

**Files:**
- Create: src/engine/step-engine.ts
- Delete: src/broker/pipeline.ts
- Modify: src/broker/index.ts

- [ ] **Step 1: Create the step engine**

Create src/engine/step-engine.ts with these exports:

- startPipeline(task, tree, db) — resolves path config, sets current_step to first step, status to active, calls executeStep
- onStepComplete(taskId, outcome, context?) — looks up current step transition, resolves target ($done/$fail/step-id), handles retries
- wireStepEngine(db) — replaces wirePipeline, listens for merge:completed to unblock dependent tasks

executeStep(taskId, step, tree, db) dispatches based on step.type:
- "worker": imports and calls spawnWorker with step.prompt
- "gate": imports and calls evaluate, then calls onStepComplete with result
- "merge": imports and calls queueMerge

onStepComplete handles transitions:
- "$done": set status=completed, current_step=$done, completed_at=now
- "$fail": check retry budget (step.max_retries or task.max_retries), re-enter step if budget allows, else set status=failed, current_step=$fail
- step ID: find step in path, update current_step and step_index, call executeStep

Use dynamic imports (await import()) for handler modules to avoid circular dependencies.

- [ ] **Step 2: Delete pipeline.ts**

Remove src/broker/pipeline.ts.

- [ ] **Step 3: Update broker/index.ts**

Replace the wirePipeline import and call with wireStepEngine:

```typescript
import { wireStepEngine } from "../engine/step-engine";
wireStepEngine(db);
```

- [ ] **Step 4: Commit**

```
git add src/engine/step-engine.ts src/broker/index.ts
git rm src/broker/pipeline.ts
git commit -m "feat: add step engine — configurable pipeline replaces hardcoded event wiring"
```

---

### Task 6: Update Worker to Use Step Engine

**Files:**
- Modify: src/agents/worker.ts
- Modify: src/shared/sandbox.ts

- [ ] **Step 1: Add stepPrompt parameter to spawnWorker**

Update signature: add optional stepPrompt?: string as last parameter.

- [ ] **Step 2: Update OverlayContext and buildOverlay in sandbox.ts**

Add stepPrompt?: string to OverlayContext interface.

In buildOverlay, after the "Strategy" section (around line 103), inject step prompt:

```typescript
  if (ctx.stepPrompt) {
    parts.push("### Step Instructions");
    parts.push(ctx.stepPrompt);
    parts.push("");
  }
```

Pass stepPrompt through when calling deploySandbox in worker.ts.

- [ ] **Step 3: Update worker status from "running" to "active"**

Find the line setting status to "running" and change to "active".

- [ ] **Step 4: Replace worker completion with onStepComplete**

In the exit handler, instead of setting "done" or "failed" directly, call:

```typescript
const { onStepComplete } = await import("../engine/step-engine");
onStepComplete(taskId, exitCode === 0 ? "success" : "failure");
```

- [ ] **Step 5: Update pause logic**

In stopWorker, replace taskSetStatus(taskId, "paused") with:

```typescript
db.run("UPDATE tasks SET paused = 1 WHERE id = ?", [taskId]);
db.addEvent(taskId, null, "task_paused", "Task paused by user");
```

- [ ] **Step 6: Commit**

```
git add src/agents/worker.ts src/shared/sandbox.ts
git commit -m "feat: worker uses step engine callbacks and accepts step prompts"
```

---

### Task 7: Update Evaluator to Use Step Engine

**Files:**
- Modify: src/agents/evaluator.ts

- [ ] **Step 1: Remove direct status setting**

Remove the line that sets status to "evaluating" (db.taskSetStatus(task.id, "evaluating")). The evaluator is now called directly by the step engine and just returns its result. The step engine handles the transition via onStepComplete.

- [ ] **Step 2: Commit**

```
git add src/agents/evaluator.ts
git commit -m "fix: evaluator no longer sets status directly — step engine handles transitions"
```

---

### Task 8: Update Merge Manager to Use Step Engine

**Files:**
- Modify: src/merge/manager.ts

- [ ] **Step 1: Replace merge success with onStepComplete**

After successful ghPrMerge(), replace the status setting block with:

```typescript
db.addEvent(task.id, null, "pr_merged", "PR #" + prNumber + " merged");
postMergeCleanup(task, tree, db);
const { onStepComplete } = await import("../engine/step-engine");
onStepComplete(task.id, "success");
```

Remove: db.taskSetStatus(task.id, "merged"), the completed_at update (step engine handles this), and bus.emit("merge:completed").

- [ ] **Step 2: Replace CI failure with onStepComplete**

In the CI failure branch, keep the failure context storage (fix instructions in session_summary), then call:

```typescript
const { onStepComplete } = await import("../engine/step-engine");
onStepComplete(task.id, "failure");
```

Remove the merge manager's internal retry logic (maxRetries check, ci_failed status, retry_exhausted event, re-enqueue). The step engine now owns retry decisions.

- [ ] **Step 3: Commit**

```
git add src/merge/manager.ts
git commit -m "feat: merge manager delegates status transitions to step engine"
```

---

### Task 9: Update Dispatch

**Files:**
- Modify: src/broker/dispatch.ts

- [ ] **Step 1: Update status checks**

- Line 24: change "ready" to "queued"
- Line 38: change taskSetStatus to "queued"
- Line 78: change dispatchable check to status !== "queued"

- [ ] **Step 2: Replace spawnWorker with startPipeline**

Replace the spawnWorker call (lines 107-109) with:

```typescript
const { startPipeline } = require("../engine/step-engine");
startPipeline(task, tree, db);
```

Remove the spawnWorker import from the top of the file.

- [ ] **Step 3: Commit**

```
git add src/broker/dispatch.ts
git commit -m "fix: dispatch uses queued status and delegates to step engine"
```

---

### Task 10: Update Server API

**Files:**
- Modify: src/broker/server.ts

- [ ] **Step 1: Add GET /api/paths endpoint**

After the GET /api/trees route, add:

```typescript
    if (path === "/api/paths" && req.method === "GET") {
      const { configNormalizedPathsForApi } = await import("./config");
      return json(configNormalizedPathsForApi());
    }
```

- [ ] **Step 2: Update status counts in GET /api/status**

Change the tasks object:

```typescript
tasks: {
  total: db.taskCount(),
  active: db.taskCount("active"),
  completed: db.taskCount("completed"),
  draft: db.taskCount("draft"),
},
```

- [ ] **Step 3: Update dispatch endpoint**

Change "ready" to "queued". Set initial current_step from path config:

```typescript
const { configNormalizedPaths } = await import("./config");
const paths = configNormalizedPaths();
const pathConfig = paths[task.path_name];
if (pathConfig && pathConfig.steps.length > 0) {
  db.run("UPDATE tasks SET current_step = ?, step_index = 0 WHERE id = ?",
    [pathConfig.steps[0].id, taskId]);
}
db.taskSetStatus(taskId, "queued");
```

- [ ] **Step 4: Update retry endpoint**

Change "running" to "active" and "ready" to "queued". Also reset paused flag:

```typescript
db.run(
  "UPDATE tasks SET status = 'queued', retry_count = retry_count + 1, paused = 0 WHERE id = ?",
  [taskId]
);
```

- [ ] **Step 5: Commit**

```
git add src/broker/server.ts
git commit -m "feat: add GET /api/paths endpoint, update status values across API"
```

---

### Task 11: Frontend — Pipeline Component Rewrite

**Files:**
- Rewrite: web/src/components/Pipeline.tsx

- [ ] **Step 1: Rewrite Pipeline.tsx**

New props: task (Task object) and steps (PathStep array from /api/paths).

Step visual resolution logic:
- If current_step is "$done": all steps render as "done"
- If current_step is "$fail": steps before step_index render as "done", step at step_index renders as "failed", rest as "pending"
- If status is "draft" or "queued": all steps render as "pending"
- If step.id matches current_step and paused: render as "paused" (amber, pause icon)
- If step.id matches current_step: render as "active" (blue, dot, glow)
- If step index < current step index: render as "done" (green, checkmark)
- Else: render as "pending" (gray)

Visual styles: done=green checkmark, active=blue dot with glow, paused=amber pause icon, failed=red X, pending=gray dot.

Connector lines between steps: green if both sides are done, gray otherwise.

- [ ] **Step 2: Commit**

```
git add web/src/components/Pipeline.tsx
git commit -m "feat: rewrite Pipeline component — data-driven from path config and task state"
```

---

### Task 12: Frontend — useTasks Hook and Task Types

**Files:**
- Modify: web/src/hooks/useTasks.ts

- [ ] **Step 1: Add new fields to Task interface**

After status (line 11), add: current_step: string | null, step_index: number, paused: number.

- [ ] **Step 2: Update Status interface**

Change tasks field to: { total: number; active: number; completed: number; draft: number }

- [ ] **Step 3: Add paths state and fetching**

Add paths state. Fetch from GET /api/paths alongside existing data. Return paths from the hook.

- [ ] **Step 4: Handle task:step WebSocket event**

Add case in handleWsMessage to update current_step and step_index on task.

- [ ] **Step 5: Commit**

```
git add web/src/hooks/useTasks.ts
git commit -m "feat: useTasks hook fetches paths and handles step change events"
```

---

### Task 13: Frontend — TaskList and TaskDetail Status Updates

**Files:**
- Modify: web/src/components/TaskList.tsx
- Modify: web/src/components/TaskDetail.tsx
- Modify: web/src/App.tsx

- [ ] **Step 1: Update STATUS_COLORS**

Replace with: draft (gray), queued (cyan), active (blue), completed (emerald), failed (red).

- [ ] **Step 2: Update STATUS_BORDER**

Replace with: active (blue), completed (emerald), failed (red).

- [ ] **Step 3: Update filter logic**

Active filter: ["draft", "queued", "active"]. Done filter: ["completed"].

- [ ] **Step 4: Update conditional rendering**

- Activity: status === "active" && !task.paused
- Dispatch button: status === "draft"
- Retry button: status === "failed" || (status === "active" && task.paused)
- Pipeline mini: ["active", "completed"].includes(status)

- [ ] **Step 5: Update status badge for active tasks**

When active, show current_step label instead of "active". When paused, show "paused: step_name".

- [ ] **Step 6: Pass paths to Pipeline components**

Add paths prop to TaskList and TaskDetail. Pass paths[task.path_name]?.steps to Pipeline alongside task. Update App.tsx to thread paths through.

- [ ] **Step 7: Update TaskDetail.tsx status references**

- Activity feed live check: status === "active" && !task.paused
- Pause button: status === "active" && !task.paused
- Cancel button: status !== "completed" && status !== "failed"

- [ ] **Step 8: Commit**

```
git add web/src/components/TaskList.tsx web/src/components/TaskDetail.tsx web/src/App.tsx
git commit -m "feat: update frontend status values, Pipeline gets data-driven props"
```

---

### Task 14: Build, Test, and Verify

**Files:**
- Build: web/ (Vite)
- Build: src/ (Bun)
- Embed: scripts/embed-web.ts

- [ ] **Step 1: Build the frontend**

Run: cd web && bun run build

Expected: Clean build, no TypeScript errors.

- [ ] **Step 2: Embed web assets**

Run: cd .. && bun run scripts/embed-web.ts

Expected: "Embedded N files into src/broker/web-assets.generated.ts"

- [ ] **Step 3: Build the backend**

Run: bun build src/broker/index.ts --target bun --outdir /tmp/grove-check

Expected: Clean build, single output file.

- [ ] **Step 4: Verify migration on existing DB**

Run: sqlite3 ~/.grove/grove.db "SELECT id, status, current_step, step_index, paused FROM tasks"

Expected: W-001 shows completed, $done, 0, 0. W-002 shows draft, null, 0, 0.

- [ ] **Step 5: Commit build artifacts**

```
git add -A
git commit -m "build: rebuild web assets after pipeline state machine changes"
```

---

## Self-Review

**Spec coverage:**
- TaskStatus reduced to 5 values: Task 1
- PipelineStep type: Task 1
- Config normalization: Task 2
- DB migration: Task 4
- Step engine: Task 5
- Handler updates (worker/evaluator/merge): Tasks 6-8
- API changes (GET /api/paths, status updates): Task 10
- Pipeline UI rewrite: Task 11
- Frontend status updates: Tasks 12-13
- Default paths with prompts: Task 1
- Paused as flag: Tasks 6, 11, 13
- current_step = $done/$fail for terminals: Task 5

**Placeholder scan:** No TBD/TODO found. All steps have implementation details.

**Type consistency:** PipelineStep used consistently. onStepComplete signature matches across all callers. NormalizedPathConfig used in config and API. PathStep in frontend matches API response shape.
