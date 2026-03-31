# Stale Worktree Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically and manually clean up orphaned git worktrees left by completed, failed, or deleted tasks.

**Architecture:** A centralized `pruneStaleWorktrees(db)` function cross-references worktrees on disk with task status in the DB. Wired into three automatic hooks (terminal task status, tree deletion, health monitor) plus a `grove cleanup` CLI command.

**Tech Stack:** Bun, SQLite (bun:sqlite), git worktree CLI, picocolors

---

### Task 1: Add `pruneStaleWorktrees` to worktree module

**Files:**
- Modify: `src/shared/worktree.ts` (after `listWorktrees`, around line 176)
- Test: `tests/shared/worktree-prune.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/shared/worktree-prune.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { pruneStaleWorktrees } from "../../src/shared/worktree";
import { join } from "node:path";
import { mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-prune.db");
const TEST_REPO = join(import.meta.dir, "test-repo");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);

  // Create a fake .grove/worktrees directory (not a real git repo,
  // so we test the DB logic; actual git worktree removal is tested via integration)
  rmSync(join(TEST_REPO, ".grove", "worktrees"), { recursive: true, force: true });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
  rmSync(join(TEST_REPO, ".grove", "worktrees"), { recursive: true, force: true });
});

function createFakeWorktree(taskId: string): string {
  const dir = join(TEST_REPO, ".grove", "worktrees", taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("pruneStaleWorktrees", () => {
  test("prunes worktree for completed task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "repo", "Done task", "completed"]);
    createFakeWorktree("W-001");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].taskId).toBe("W-001");
    expect(result.pruned[0].reason).toBe("completed");
  });

  test("prunes worktree for failed task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "repo", "Failed task", "failed"]);
    createFakeWorktree("W-002");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].reason).toBe("failed");
  });

  test("prunes worktree for orphaned task (no DB record)", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    createFakeWorktree("W-999");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(1);
    expect(result.pruned[0].reason).toBe("orphaned");
  });

  test("skips worktree for active task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-003", "repo", "Active task", "active"]);
    createFakeWorktree("W-003");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
  });

  test("skips worktree for paused task", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-004", "repo", "Paused task", "paused"]);
    createFakeWorktree("W-004");

    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
  });

  test("returns empty when no stale worktrees", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: TEST_REPO });
    const result = pruneStaleWorktrees(db);
    expect(result.pruned.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/shared/worktree-prune.test.ts`
Expected: FAIL — `pruneStaleWorktrees` is not exported from worktree.ts

- [ ] **Step 3: Implement `pruneStaleWorktrees`**

In `src/shared/worktree.ts`, add the types and function after `branchName()` at the end of the file:

```typescript
/** Result of a single worktree prune */
export interface PrunedEntry {
  taskId: string;
  treeId: string;
  reason: "completed" | "failed" | "orphaned";
}

/** Result of pruning all stale worktrees */
export interface PruneResult {
  pruned: PrunedEntry[];
  errors: string[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const KEEP_STATUSES = new Set(["active", "queued", "draft", "paused"]);

/**
 * Scan all trees for stale worktrees and remove them.
 * A worktree is stale if its task is completed, failed, or missing from the DB.
 */
export function pruneStaleWorktrees(db: Database): PruneResult {
  const pruned: PrunedEntry[] = [];
  const errors: string[] = [];

  const trees = db.allTrees();

  for (const tree of trees) {
    const treePath = expandHome(tree.path);
    const worktreeDir = join(treePath, ".grove", "worktrees");

    if (!existsSync(worktreeDir)) continue;

    // Read directories directly — faster than git worktree list and works
    // even if the worktree is in a broken state
    let entries: string[];
    try {
      const { readdirSync } = require("node:fs");
      entries = readdirSync(worktreeDir) as string[];
    } catch {
      continue;
    }

    for (const taskId of entries) {
      const taskPath = join(worktreeDir, taskId);
      try {
        const { statSync } = require("node:fs");
        if (!statSync(taskPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const task = db.taskGet(taskId);

      let reason: PrunedEntry["reason"] | null = null;
      if (!task) {
        reason = "orphaned";
      } else if (TERMINAL_STATUSES.has(task.status)) {
        reason = task.status as "completed" | "failed";
      } else if (KEEP_STATUSES.has(task.status)) {
        continue;
      } else {
        // Unknown status — skip to be safe
        continue;
      }

      try {
        cleanupWorktree(taskId, tree.path);
        pruned.push({ taskId, treeId: tree.id, reason: reason! });
      } catch (err: any) {
        errors.push(`${taskId}: ${err.message}`);
      }
    }
  }

  return { pruned, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/shared/worktree-prune.test.ts`
Expected: PASS (6 tests)

Note: The `cleanupWorktree` call will run `git worktree remove` which may fail on fake directories (not real git worktrees), but `cleanupWorktree` already guards with `existsSync` and uses best-effort git commands. The directories created by `createFakeWorktree` will be removed by the `rmSync` in the git worktree remove step or by `afterEach`. If tests fail because git complains about fake worktrees, the `pruned` entry will still be added because `cleanupWorktree` doesn't throw (it's fire-and-forget git commands). If the directory isn't actually removed, that's fine for unit tests — we're testing the DB logic and selection criteria.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/shared/worktree.ts tests/shared/worktree-prune.test.ts
git commit -m "feat: add pruneStaleWorktrees to identify and remove orphaned worktrees (#110)"
```

---

### Task 2: Add per-task cleanup on terminal status in step-engine

**Files:**
- Modify: `src/engine/step-engine.ts:163-208` (the `$done` and `$fail` terminal handlers in `onStepComplete`)

- [ ] **Step 1: Add worktree cleanup to the `$done` handler**

In `src/engine/step-engine.ts`, find the `$done` block (around line 164). After the task status is updated and events emitted, add worktree cleanup. Replace the block:

```typescript
  // --- $done ---
  if (target === "$done") {
    db.run(
      "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    bus.emit("task:status", { taskId, status: "completed" });
    bus.emit("merge:completed", { taskId, prNumber: task.pr_number ?? 0 });

    // Clean up worktree now that task is complete
    if (task.tree_id) {
      const tree = db.treeGet(task.tree_id);
      if (tree) {
        try {
          const { cleanupWorktree } = await import("../shared/worktree");
          cleanupWorktree(taskId, tree.path);
        } catch { /* best-effort */ }
      }
    }
    return;
  }
```

Note: `onStepComplete` is not async. The dynamic import returns a Promise. Since this is best-effort cleanup, use `.then().catch()` instead:

```typescript
  // --- $done ---
  if (target === "$done") {
    db.run(
      "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    bus.emit("task:status", { taskId, status: "completed" });
    bus.emit("merge:completed", { taskId, prNumber: task.pr_number ?? 0 });

    // Best-effort worktree cleanup
    if (task.tree_id) {
      const tree = db.treeGet(task.tree_id);
      if (tree) {
        import("../shared/worktree").then(({ cleanupWorktree }) => {
          cleanupWorktree(taskId, tree.path);
        }).catch(() => {});
      }
    }
    return;
  }
```

- [ ] **Step 2: Add worktree cleanup to the `$fail` (retries exhausted) handler**

In the same function, find the retries-exhausted block (around line 197). After the status update and event, add the same cleanup pattern:

```typescript
    // Retries exhausted
    db.run(
      "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
      [taskId],
    );
    db.addEvent(
      taskId,
      null,
      "retry_exhausted",
      `Retries exhausted (${task.max_retries})${context ? `: ${context}` : ""}`,
    );
    bus.emit("task:status", { taskId, status: "failed" });

    // Best-effort worktree cleanup
    if (task.tree_id) {
      const tree = db.treeGet(task.tree_id);
      if (tree) {
        import("../shared/worktree").then(({ cleanupWorktree }) => {
          cleanupWorktree(taskId, tree.path);
        }).catch(() => {});
      }
    }
    return;
```

- [ ] **Step 3: Add worktree cleanup to `failTask` helper**

Find the `failTask` helper function in step-engine.ts (it handles fatal failures). Add the same pattern there:

```typescript
function failTask(db: Database, taskId: string, reason: string): void {
  db.run(
    "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
    [taskId],
  );
  db.addEvent(taskId, null, "task_failed", reason);
  bus.emit("task:status", { taskId, status: "failed" });

  // Best-effort worktree cleanup
  const task = db.taskGet(taskId);
  if (task?.tree_id) {
    const tree = db.treeGet(task.tree_id);
    if (tree) {
      import("../shared/worktree").then(({ cleanupWorktree }) => {
        cleanupWorktree(taskId, tree.path);
      }).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/engine/step-engine.ts
git commit -m "feat: auto-cleanup worktrees on task completion and failure (#110)"
```

---

### Task 3: Add worktree cleanup to tree deletion endpoint

**Files:**
- Modify: `src/broker/server.ts:475-498` (the `DELETE /api/trees/:id` handler)

- [ ] **Step 1: Add worktree cleanup before tree deletion**

In `src/broker/server.ts`, update the `DELETE /api/trees/:id` handler. After `taskDeleteByTree` but before `treeDelete`, clean up any worktrees on disk. Replace the handler body:

```typescript
    // DELETE /api/trees/:id — remove a tree (blocks if tasks exist unless ?force=true)
    const deleteTreeMatch = path.match(/^\/api\/trees\/([^/]+)$/);
    if (deleteTreeMatch && req.method === "DELETE") {
      const tree = db.treeGet(deleteTreeMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);

      const tasks = db.tasksByTree(tree.id);
      const url = new URL(req.url);
      const force = url.searchParams.get("force") === "true";

      if (tasks.length > 0 && !force) {
        return json({ error: "Tree has tasks", task_count: tasks.length }, 409);
      }

      const deletedTasks = tasks.length > 0 ? db.taskDeleteByTree(tree.id) : 0;

      // Clean up any worktrees on disk before removing the tree
      try {
        const { listWorktrees, cleanupWorktree } = await import("../shared/worktree");
        const worktrees = listWorktrees(tree.path);
        for (const wt of worktrees) {
          cleanupWorktree(wt.taskId, tree.path);
        }
      } catch { /* best-effort */ }

      db.treeDelete(tree.id);

      // Remove from YAML config
      const { configDeleteTree } = await import("./config");
      configDeleteTree(tree.id);

      db.addEvent(null, null, "tree_removed", `Removed tree ${tree.id} (${deletedTasks} tasks deleted)`);
      return json({ ok: true, tree: tree.id, tasks_deleted: deletedTasks });
    }
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: clean up worktrees when deleting a tree (#110)"
```

---

### Task 4: Add periodic cleanup to health monitor

**Files:**
- Modify: `src/monitor/health.ts:21-30` (the `startHealthMonitor` function)

- [ ] **Step 1: Add pruneStaleWorktrees to the health check interval**

In `src/monitor/health.ts`, add a periodic call to `pruneStaleWorktrees`. Import at top and add to the interval callback. Add this import at the top of the file (after existing imports):

```typescript
import { pruneStaleWorktrees } from "../shared/worktree";
```

Then update the `startHealthMonitor` function's interval callback:

```typescript
export function startHealthMonitor(opts: MonitorOptions): void {
  const { db, stallTimeoutMinutes, intervalMs = 15_000, onOrchestratorCrash } = opts;

  if (intervalHandle) return; // Already running

  // Run prune on a slower cadence (every 5 minutes, not every 15s)
  let pruneCounter = 0;
  const PRUNE_EVERY_N = 20; // 20 * 15s = 5 minutes

  intervalHandle = setInterval(() => {
    checkWorkers(db, stallTimeoutMinutes);
    checkOrchestrator(db, onOrchestratorCrash);

    pruneCounter++;
    if (pruneCounter >= PRUNE_EVERY_N) {
      pruneCounter = 0;
      try {
        pruneStaleWorktrees(db);
      } catch { /* best-effort */ }
    }
  }, intervalMs);
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/monitor/health.ts
git commit -m "feat: periodic stale worktree pruning in health monitor (#110)"
```

---

### Task 5: Add `grove cleanup` CLI command and API endpoint

**Files:**
- Create: `src/cli/commands/cleanup.ts`
- Modify: `src/cli/index.ts:6-22` (add cleanup to command map)
- Modify: `src/broker/server.ts` (add `POST /api/cleanup/worktrees` endpoint)
- Modify: `src/cli/commands/help.ts` (add cleanup to help)

- [ ] **Step 1: Add API endpoint**

In `src/broker/server.ts`, add after the existing `DELETE /api/trees/:id` block (around line 498):

```typescript
    // POST /api/cleanup/worktrees — prune stale worktrees
    if (path === "/api/cleanup/worktrees" && req.method === "POST") {
      const { pruneStaleWorktrees } = await import("../shared/worktree");
      const result = pruneStaleWorktrees(db);
      return json(result);
    }
```

- [ ] **Step 2: Create CLI command**

Create `src/cli/commands/cleanup.ts`:

```typescript
// grove cleanup — Prune stale worktrees
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(_args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/cleanup/worktrees`, {
      method: "POST",
    });
    const data = await resp.json() as { pruned: Array<{ taskId: string; treeId: string; reason: string }>; errors: string[] };

    if (data.pruned.length === 0) {
      console.log(`${pc.green("✓")} No stale worktrees found`);
      return;
    }

    console.log(`${pc.green("✓")} Pruned ${data.pruned.length} stale worktree${data.pruned.length === 1 ? "" : "s"}`);
    for (const entry of data.pruned) {
      console.log(`  ${entry.taskId} ${pc.dim(`(${entry.reason})`)} — ${entry.treeId}`);
    }

    if (data.errors.length > 0) {
      console.log();
      console.log(`${pc.yellow("Errors:")}`);
      for (const err of data.errors) {
        console.log(`  ${pc.red("✘")} ${err}`);
      }
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
```

- [ ] **Step 3: Register in CLI router**

In `src/cli/index.ts`, add to the `commands` object (after `cost`):

```typescript
  cleanup: () => import("./commands/cleanup"),
```

- [ ] **Step 4: Update help text**

In `src/cli/commands/help.ts`, add to the Monitoring section (after `cost`):

```typescript
  ${pc.green("cleanup")}          Prune stale worktrees
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Test CLI help output**

Run: `bun run src/cli/index.ts help`
Expected: Shows `cleanup` in Monitoring section

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/cleanup.ts src/cli/index.ts src/broker/server.ts src/cli/commands/help.ts
git commit -m "feat: add grove cleanup command and API endpoint (#110)"
```
