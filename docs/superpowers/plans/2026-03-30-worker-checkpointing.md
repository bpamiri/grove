# T6: Worker Checkpointing & Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers commit WIP before shutdown and write a structured checkpoint. On resume, workers receive checkpoint context in their CLAUDE.md overlay and continue from where they left off.

**Architecture:** On graceful shutdown (SIGTERM → 10s grace period), the broker runs `git add -A && git commit` for uncommitted changes, writes a checkpoint JSON, and stores it in the DB. On resume, the step engine loads the checkpoint and includes it in the CLAUDE.md overlay.

**Tech Stack:** Bun, TypeScript, Git CLI

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T6 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/agents/checkpoint.ts` | Checkpoint creation, WIP commit, loading |
| Create | `tests/agents/checkpoint.test.ts` | Checkpoint unit tests |
| Modify | `src/agents/worker.ts` | Graceful shutdown with checkpoint |
| Modify | `src/shared/sandbox.ts` | CLAUDE.md overlay includes checkpoint context |
| Modify | `src/shared/types.ts` | Add `checkpoint` to Task |
| Modify | `src/broker/schema-sql.ts` | Add `checkpoint TEXT` column |
| Modify | `src/broker/db.ts` | checkpointSave/checkpointLoad helpers |
| Modify | `src/monitor/health.ts` | Checkpoint before stall kill |

---

### Task 1: Checkpoint Module

**Files:** Create `src/agents/checkpoint.ts`, `tests/agents/checkpoint.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/agents/checkpoint.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createCheckpoint, loadCheckpoint, commitWip, type Checkpoint } from "../../src/agents/checkpoint";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

const TEST_DIR = join(import.meta.dir, "test-checkpoint-repo");

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".grove"), { recursive: true });
  // Init git repo
  Bun.spawnSync(["git", "init"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "initial.txt"), "init");
  Bun.spawnSync(["git", "add", "-A"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: TEST_DIR });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("commitWip", () => {
  test("commits uncommitted changes", () => {
    writeFileSync(join(TEST_DIR, "new-file.ts"), "export const x = 1;");
    const sha = commitWip(TEST_DIR, "W-001");
    expect(sha).not.toBeNull();
    expect(sha!.length).toBeGreaterThan(6);
  });

  test("returns null when no changes", () => {
    const sha = commitWip(TEST_DIR, "W-001");
    expect(sha).toBeNull();
  });
});

describe("createCheckpoint", () => {
  test("creates checkpoint JSON in .grove/", () => {
    writeFileSync(join(TEST_DIR, "work.ts"), "export const y = 2;");
    const checkpoint = createCheckpoint(TEST_DIR, {
      taskId: "W-001",
      stepId: "implement",
      stepIndex: 1,
      sessionSummary: "Started implementing auth",
      costSoFar: 0.50,
      tokensSoFar: 5000,
    });
    expect(checkpoint.taskId).toBe("W-001");
    expect(checkpoint.commitSha).not.toBeNull();
    expect(checkpoint.filesModified.length).toBeGreaterThan(0);

    // Verify file was written
    const filePath = join(TEST_DIR, ".grove", "checkpoint.json");
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("loadCheckpoint", () => {
  test("loads checkpoint from .grove/checkpoint.json", () => {
    const checkpoint: Checkpoint = {
      taskId: "W-001",
      stepId: "implement",
      stepIndex: 1,
      timestamp: new Date().toISOString(),
      commitSha: "abc123",
      filesModified: ["src/a.ts"],
      sessionSummary: "Did work",
      nextAction: "Continue",
      costSoFar: 1.0,
      tokensSoFar: 10000,
    };
    writeFileSync(join(TEST_DIR, ".grove", "checkpoint.json"), JSON.stringify(checkpoint));

    const loaded = loadCheckpoint(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("W-001");
    expect(loaded!.sessionSummary).toBe("Did work");
  });

  test("returns null when no checkpoint exists", () => {
    expect(loadCheckpoint(TEST_DIR)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/agents/checkpoint.test.ts`

- [ ] **Step 3: Implement checkpoint module**

Create `src/agents/checkpoint.ts`:

```typescript
// Grove v3 — Worker checkpointing: WIP commit + state persistence
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Checkpoint {
  taskId: string;
  stepId: string;
  stepIndex: number;
  timestamp: string;
  commitSha: string | null;
  filesModified: string[];
  sessionSummary: string;
  nextAction: string;
  costSoFar: number;
  tokensSoFar: number;
}

interface CreateOpts {
  taskId: string;
  stepId: string;
  stepIndex: number;
  sessionSummary: string;
  costSoFar: number;
  tokensSoFar: number;
}

/** Commit any uncommitted changes as a WIP checkpoint. Returns SHA or null if nothing to commit. */
export function commitWip(worktreePath: string, taskId: string): string | null {
  // Check for changes
  const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktreePath });
  const hasChanges = statusResult.stdout.toString().trim().length > 0;
  if (!hasChanges) return null;

  // Stage and commit
  Bun.spawnSync(["git", "add", "-A"], { cwd: worktreePath });
  const commitResult = Bun.spawnSync(
    ["git", "commit", "-m", `grove: WIP checkpoint for ${taskId}`],
    { cwd: worktreePath },
  );
  if (commitResult.exitCode !== 0) return null;

  // Get SHA
  const shaResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktreePath });
  return shaResult.stdout.toString().trim() || null;
}

/** Create a checkpoint: commit WIP, get file list, write JSON. */
export function createCheckpoint(worktreePath: string, opts: CreateOpts): Checkpoint {
  const sha = commitWip(worktreePath, opts.taskId);

  // Get files modified
  const diffResult = Bun.spawnSync(["git", "diff", "--name-only", "HEAD~1..HEAD"], { cwd: worktreePath });
  const filesModified = diffResult.exitCode === 0
    ? diffResult.stdout.toString().trim().split("\n").filter(Boolean)
    : [];

  // Read session summary if worker wrote one
  const summaryPath = join(worktreePath, ".grove", "session-summary.md");
  const summary = existsSync(summaryPath)
    ? readFileSync(summaryPath, "utf-8")
    : opts.sessionSummary;

  const checkpoint: Checkpoint = {
    taskId: opts.taskId,
    stepId: opts.stepId,
    stepIndex: opts.stepIndex,
    timestamp: new Date().toISOString(),
    commitSha: sha,
    filesModified,
    sessionSummary: summary,
    nextAction: "",
    costSoFar: opts.costSoFar,
    tokensSoFar: opts.tokensSoFar,
  };

  // Write to worktree
  const checkpointPath = join(worktreePath, ".grove", "checkpoint.json");
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

  return checkpoint;
}

/** Load a checkpoint from the worktree. Returns null if none exists. */
export function loadCheckpoint(worktreePath: string): Checkpoint | null {
  const checkpointPath = join(worktreePath, ".grove", "checkpoint.json");
  if (!existsSync(checkpointPath)) return null;
  try {
    return JSON.parse(readFileSync(checkpointPath, "utf-8"));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agents/checkpoint.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/checkpoint.ts tests/agents/checkpoint.test.ts
git commit -m "feat: add checkpoint module with WIP commit and state persistence"
```

---

### Task 2: Schema + DB Helpers

**Files:** Modify `src/shared/types.ts`, `src/broker/schema-sql.ts`, `src/broker/db.ts`

- [ ] **Step 1: Add checkpoint to Task type**

In `src/shared/types.ts`, add to Task interface (after `source_pr`):
```typescript
  checkpoint: string | null;  // JSON
```

- [ ] **Step 2: Add checkpoint column to schema**

In `src/broker/schema-sql.ts`, add after `source_pr INTEGER` in the tasks table:
```sql
  checkpoint TEXT
```

- [ ] **Step 3: Add DB helpers**

In `src/broker/db.ts`, add methods:

```typescript
  checkpointSave(taskId: string, checkpoint: string): void {
    this.run("UPDATE tasks SET checkpoint = ? WHERE id = ?", [checkpoint, taskId]);
  }

  checkpointLoad(taskId: string): string | null {
    return this.scalar<string>("SELECT checkpoint FROM tasks WHERE id = ?", [taskId]);
  }
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/broker/schema-sql.ts src/broker/db.ts
git commit -m "feat: add checkpoint column and DB helpers"
```

---

### Task 3: Graceful Worker Shutdown with Checkpoint

**Files:** Modify `src/agents/worker.ts`

- [ ] **Step 1: Update stopWorker to create checkpoint before killing**

In `src/agents/worker.ts`, add import:
```typescript
import { createCheckpoint } from "./checkpoint";
```

Replace the `stopWorker` function:

```typescript
export function stopWorker(taskId: string, db: Database): boolean {
  const handle = activeWorkers.get(taskId);
  if (!handle) return false;

  // Create checkpoint before killing
  try {
    const task = db.taskGet(taskId);
    if (task && handle.worktreePath) {
      const checkpoint = createCheckpoint(handle.worktreePath, {
        taskId,
        stepId: task.current_step ?? "",
        stepIndex: task.step_index ?? 0,
        sessionSummary: task.session_summary ?? "",
        costSoFar: task.cost_usd,
        tokensSoFar: task.tokens_used,
      });
      db.checkpointSave(taskId, JSON.stringify(checkpoint));
    }
  } catch (err) {
    console.error(`[worker] Checkpoint failed for ${taskId}:`, err);
  }

  try {
    handle.proc.kill();
  } catch {}

  db.sessionEnd(handle.sessionId, "stopped");
  db.run("UPDATE tasks SET paused = 1 WHERE id = ?", [taskId]);
  db.addEvent(taskId, null, "task_paused", "Task paused by user (checkpoint saved)");
  activeWorkers.delete(taskId);

  bus.emit("worker:ended", { taskId, sessionId: handle.sessionId, status: "stopped" });
  bus.emit("agent:ended", { agentId: handle.sessionId, role: "worker", taskId, exitCode: -1, ts: Date.now() });
  return true;
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/agents/worker.ts
git commit -m "feat: create checkpoint on graceful worker shutdown"
```

---

### Task 4: Checkpoint Context in CLAUDE.md Overlay

**Files:** Modify `src/shared/sandbox.ts`

- [ ] **Step 1: Add checkpoint to OverlayContext and CLAUDE.md**

In `src/shared/sandbox.ts`, find the `OverlayContext` interface and add:

```typescript
  checkpoint?: {
    stepId: string;
    stepIndex: number;
    commitSha: string | null;
    filesModified: string[];
    sessionSummary: string;
    costSoFar: number;
  } | null;
```

In the `deploySandbox` function, where the CLAUDE.md overlay is built, add a checkpoint section before the existing session summary section:

```typescript
  // Checkpoint context (for resumed tasks)
  if (ctx.checkpoint) {
    overlay += `\n## Checkpoint — Resuming from prior session
- **Step:** ${ctx.checkpoint.stepId} (index ${ctx.checkpoint.stepIndex})
${ctx.checkpoint.commitSha ? `- **Last commit:** ${ctx.checkpoint.commitSha}` : ""}
${ctx.checkpoint.filesModified.length > 0 ? `- **Files modified:** ${ctx.checkpoint.filesModified.join(", ")}` : ""}
- **Summary:** ${ctx.checkpoint.sessionSummary}
- **Cost so far:** $${ctx.checkpoint.costSoFar.toFixed(2)}

Continue from where you left off. The WIP commit contains your in-progress work.
Do NOT repeat work that's already committed.\n`;
  }
```

- [ ] **Step 2: Wire checkpoint loading in worker.ts spawnWorker**

In `src/agents/worker.ts`, add import:
```typescript
import { loadCheckpoint } from "./checkpoint";
```

In `spawnWorker()`, before `deploySandbox()`, load the checkpoint:

```typescript
  // Load checkpoint if resuming
  const checkpointJson = db.checkpointLoad(task.id);
  let checkpointCtx = undefined;
  if (checkpointJson) {
    try {
      const cp = JSON.parse(checkpointJson);
      checkpointCtx = {
        stepId: cp.stepId,
        stepIndex: cp.stepIndex,
        commitSha: cp.commitSha,
        filesModified: cp.filesModified ?? [],
        sessionSummary: cp.sessionSummary ?? "",
        costSoFar: cp.costSoFar ?? 0,
      };
    } catch {}
  }
```

Then pass it to `deploySandbox`:
```typescript
  deploySandbox(worktreePath, {
    ...existingContext,
    checkpoint: checkpointCtx,
  });
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/sandbox.ts src/agents/worker.ts
git commit -m "feat: include checkpoint context in CLAUDE.md overlay on resume"
```

---

### Task 5: Checkpoint on Stall Timeout

**Files:** Modify `src/monitor/health.ts`

- [ ] **Step 1: Add checkpoint before stall kill**

In `src/monitor/health.ts`, add import:
```typescript
import { createCheckpoint } from "../agents/checkpoint";
```

In the stall detection logic, before the worker is marked as crashed, add checkpoint:

Find where stall is detected and the worker is killed. Before the kill/crash handling, add:

```typescript
    // Save checkpoint before marking as crashed
    try {
      const task = db.taskGet(session.task_id!);
      const handle = getActiveWorkers().get(session.task_id!);
      if (task && handle?.worktreePath) {
        const checkpoint = createCheckpoint(handle.worktreePath, {
          taskId: task.id,
          stepId: task.current_step ?? "",
          stepIndex: task.step_index ?? 0,
          sessionSummary: task.session_summary ?? "Stalled — no activity detected",
          costSoFar: task.cost_usd,
          tokensSoFar: task.tokens_used,
        });
        db.checkpointSave(task.id, JSON.stringify(checkpoint));
      }
    } catch (err) {
      console.error(`[health] Checkpoint failed for stalled worker:`, err);
    }
```

You'll need to import `getActiveWorkers` from worker.ts.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/monitor/health.ts
git commit -m "feat: create checkpoint before stall timeout kills worker"
```
