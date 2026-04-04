# Auto-Rebase Worktree on Main Before Evaluate Step

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically rebase the task branch onto latest `origin/main` before read-only evaluation steps, preventing phantom test failures caused by stale worktrees in parallel task execution.

**Architecture:** Add a `rebaseOnMain()` git utility in `src/shared/worktree.ts` that fetches and rebases. Hook it into `executeStep()` in `src/engine/step-engine.ts` — before spawning a worker for read-only (evaluation) steps, run the rebase. Gate it behind `rebase_before_eval` in `SettingsConfig` (default `true`). On conflict, abort the rebase, record an event with conflicting files, and fail the step so the implement step can retry.

**Tech Stack:** TypeScript, Bun, `Bun.spawnSync` for git commands, bun:test

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/worktree.ts` | Modify | Add `rebaseOnMain()` function |
| `src/shared/types.ts` | Modify | Add `rebase_before_eval` to `SettingsConfig` |
| `src/engine/step-engine.ts` | Modify | Call `rebaseOnMain()` before read-only worker steps |
| `tests/shared/worktree-rebase.test.ts` | Create | Unit tests for `rebaseOnMain()` |
| `tests/engine/step-engine.test.ts` | Modify | Integration tests for rebase-before-eval in pipeline |

---

### Task 1: Add `rebase_before_eval` to SettingsConfig

**Files:**
- Modify: `src/shared/types.ts:208-215`

- [ ] **Step 1: Add the field to SettingsConfig interface**

In `src/shared/types.ts`, add `rebase_before_eval` to the `SettingsConfig` interface:

```typescript
export interface SettingsConfig {
  max_workers: number;
  branch_prefix: string;
  stall_timeout_minutes: number;
  max_retries: number;
  default_adapter?: string;
  proactive?: boolean;
  rebase_before_eval?: boolean;
}
```

- [ ] **Step 2: Add the default value**

In `src/shared/types.ts`, add `rebase_before_eval: true` to `DEFAULT_SETTINGS`:

```typescript
export const DEFAULT_SETTINGS: SettingsConfig = {
  max_workers: 5,
  branch_prefix: "grove/",
  stall_timeout_minutes: 5,
  max_retries: 2,
  proactive: true,
  rebase_before_eval: true,
};
```

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun run build`
Expected: Clean build, no type errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: (W-078) add rebase_before_eval setting to SettingsConfig"
```

---

### Task 2: Add `rebaseOnMain()` to worktree utilities

**Files:**
- Modify: `src/shared/worktree.ts`
- Create: `tests/shared/worktree-rebase.test.ts`

- [ ] **Step 1: Write the failing test — clean rebase succeeds**

Create `tests/shared/worktree-rebase.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createFixtureRepo } from "../fixtures/helpers";

// Import after creating fixtures since worktree.ts uses Bun.spawnSync
import { rebaseOnMain } from "../../src/shared/worktree";

function gitInDir(dir: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return r.stdout.toString().trim();
}

describe("rebaseOnMain", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  function setupRepoWithWorktree(): {
    repoPath: string;
    worktreePath: string;
    cleanup: () => void;
  } {
    // Create a "remote" bare repo to act as origin
    const { repoPath: originPath, cleanup: cleanupOrigin } = createFixtureRepo();
    // Create a bare clone to act as origin
    const barePath = originPath + "-bare";
    Bun.spawnSync(["git", "clone", "--bare", originPath, barePath]);

    // Clone from bare to create "local" repo
    const localPath = originPath + "-local";
    Bun.spawnSync(["git", "clone", barePath, localPath]);
    Bun.spawnSync(["git", "-C", localPath, "config", "user.email", "test@grove.dev"]);
    Bun.spawnSync(["git", "-C", localPath, "config", "user.name", "Grove Test"]);

    // Create worktree on a feature branch
    const worktreeDir = join(localPath, ".grove", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });
    const worktreePath = join(worktreeDir, "T-001");
    Bun.spawnSync(["git", "-C", localPath, "worktree", "add", "-b", "grove/T-001-test", worktreePath, "origin/main"]);
    Bun.spawnSync(["git", "-C", worktreePath, "config", "user.email", "test@grove.dev"]);
    Bun.spawnSync(["git", "-C", worktreePath, "config", "user.name", "Grove Test"]);

    // Make a commit on the worktree branch
    writeFileSync(join(worktreePath, "feature.txt"), "feature work\n");
    Bun.spawnSync(["git", "-C", worktreePath, "add", "."]);
    Bun.spawnSync(["git", "-C", worktreePath, "commit", "-m", "Add feature"]);

    // Simulate another task merging to main: push a new commit to origin/main
    // Clone the bare repo again to push changes
    const pusherPath = originPath + "-pusher";
    Bun.spawnSync(["git", "clone", barePath, pusherPath]);
    Bun.spawnSync(["git", "-C", pusherPath, "config", "user.email", "other@grove.dev"]);
    Bun.spawnSync(["git", "-C", pusherPath, "config", "user.name", "Other Dev"]);
    writeFileSync(join(pusherPath, "other-task.txt"), "other task work\n");
    Bun.spawnSync(["git", "-C", pusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", pusherPath, "commit", "-m", "Other task merged"]);
    Bun.spawnSync(["git", "-C", pusherPath, "push", "origin", "main"]);

    const cleanup = () => {
      // Clean up worktree first
      Bun.spawnSync(["git", "-C", localPath, "worktree", "remove", worktreePath, "--force"]);
      cleanupOrigin();
      for (const p of [barePath, localPath, pusherPath]) {
        Bun.spawnSync(["rm", "-rf", p]);
      }
    };
    cleanups.push(cleanup);

    return { repoPath: localPath, worktreePath, cleanup };
  }

  test("clean rebase succeeds and includes upstream changes", () => {
    const { worktreePath } = setupRepoWithWorktree();

    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toBeUndefined();

    // Verify the worktree has the upstream commit
    const log = gitInDir(worktreePath, ["log", "--oneline"]);
    expect(log).toContain("Other task merged");
    expect(log).toContain("Add feature");
  });

  test("returns conflict info when rebase has conflicts", () => {
    const { repoPath, worktreePath } = setupRepoWithWorktree();

    // Create a conflict: modify README.md in worktree (already modified on main via initial commit)
    // First, push a conflicting change to origin/main
    const barePath = repoPath.replace("-local", "") + "-bare";
    const conflictPusherPath = repoPath + "-conflict-pusher";
    Bun.spawnSync(["git", "clone", barePath, conflictPusherPath]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "config", "user.email", "conflict@grove.dev"]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "config", "user.name", "Conflict Dev"]);
    writeFileSync(join(conflictPusherPath, "README.md"), "# Conflicting change\n");
    Bun.spawnSync(["git", "-C", conflictPusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "commit", "-m", "Conflict on README"]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "push", "origin", "main"]);
    cleanups.push(() => Bun.spawnSync(["rm", "-rf", conflictPusherPath]));

    // Modify the same file in the worktree
    writeFileSync(join(worktreePath, "README.md"), "# My conflicting change\n");
    Bun.spawnSync(["git", "-C", worktreePath, "add", "."]);
    Bun.spawnSync(["git", "-C", worktreePath, "commit", "-m", "Conflicting README change"]);

    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(false);
    expect(result.conflictFiles).toBeDefined();
    expect(result.conflictFiles!.length).toBeGreaterThan(0);
    expect(result.conflictFiles).toContain("README.md");

    // Verify rebase was aborted (branch is clean)
    const status = gitInDir(worktreePath, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  test("respects custom defaultBranch parameter", () => {
    // Create a setup where the default branch is "develop" instead of "main"
    const { repoPath, worktreePath } = setupRepoWithWorktree();

    // Create a "develop" branch on origin with a unique commit
    const barePath = repoPath.replace("-local", "") + "-bare";
    const devPusherPath = repoPath + "-dev-pusher";
    Bun.spawnSync(["git", "clone", barePath, devPusherPath]);
    Bun.spawnSync(["git", "-C", devPusherPath, "config", "user.email", "dev@grove.dev"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "config", "user.name", "Dev Pusher"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "checkout", "-b", "develop"]);
    writeFileSync(join(devPusherPath, "develop-only.txt"), "develop branch content\n");
    Bun.spawnSync(["git", "-C", devPusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", devPusherPath, "commit", "-m", "Develop branch commit"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "push", "origin", "develop"]);
    cleanups.push(() => Bun.spawnSync(["rm", "-rf", devPusherPath]));

    // Fetch in local so origin/develop exists
    Bun.spawnSync(["git", "-C", repoPath, "fetch", "origin"]);

    const result = rebaseOnMain(worktreePath, "develop");

    expect(result.ok).toBe(true);

    // Verify develop-only.txt is now in the worktree
    const log = gitInDir(worktreePath, ["log", "--oneline"]);
    expect(log).toContain("Develop branch commit");
  });

  test("no-op when already up to date", () => {
    const { repoPath, worktreePath } = setupRepoWithWorktree();

    // First rebase to get up to date
    rebaseOnMain(worktreePath);

    // Second rebase should be a no-op success
    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun test tests/shared/worktree-rebase.test.ts`
Expected: FAIL — `rebaseOnMain` is not exported from worktree.ts

- [ ] **Step 3: Implement `rebaseOnMain()`**

Add to the end of `src/shared/worktree.ts` (before the closing of the file), using the existing `git()` helper and `resolveDefaultBranch()`:

First, export `resolveDefaultBranch` (it's currently private). Change:
```typescript
function resolveDefaultBranch(repoPath: string, configured?: string): string {
```
to:
```typescript
export function resolveDefaultBranch(repoPath: string, configured?: string): string {
```

Then add `rebaseOnMain`:

```typescript
/** Result of a rebase-on-main attempt */
export interface RebaseResult {
  ok: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Fetch origin and rebase the current branch onto the default branch.
 * Used before evaluation steps to ensure the worktree has the latest main.
 * On conflict, aborts the rebase and returns the list of conflicting files.
 */
export function rebaseOnMain(worktreePath: string, defaultBranch?: string): RebaseResult {
  // Resolve which remote branch to rebase onto
  const target = resolveDefaultBranch(worktreePath, defaultBranch);
  const remoteBranch = target.replace("origin/", "");

  // Fetch latest from origin
  const fetch = git(worktreePath, ["fetch", "origin", remoteBranch]);
  if (!fetch.ok) {
    return { ok: false, error: `fetch failed: ${fetch.stderr}` };
  }

  // Attempt rebase
  const rebase = git(worktreePath, ["rebase", target]);
  if (rebase.ok) {
    return { ok: true };
  }

  // Rebase failed — collect conflicting files before aborting
  const diffResult = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  const conflictFiles = diffResult.stdout
    .split("\n")
    .map(f => f.trim())
    .filter(Boolean);

  // Abort the rebase to restore clean state
  git(worktreePath, ["rebase", "--abort"]);

  return {
    ok: false,
    conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
    error: `rebase conflict with ${target}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun test tests/shared/worktree-rebase.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/worktree.ts tests/shared/worktree-rebase.test.ts
git commit -m "feat: (W-078) add rebaseOnMain() utility for pre-eval rebase"
```

---

### Task 3: Hook rebase into step engine before read-only steps

**Files:**
- Modify: `src/engine/step-engine.ts:311-369`

- [ ] **Step 1: Add the rebase call in executeStep()**

In `src/engine/step-engine.ts`, modify the `executeStep()` function. Add the rebase logic after the plugin pre-hook check and before the `switch (step.type)` block. Import `settingsGet` and `rebaseOnMain`:

Add to the imports at the top of the file:
```typescript
import { settingsGet } from "../broker/config";
```

Then in `executeStep()`, between the plugin hook block (ending ~line 338) and the `switch (step.type)` (line 340), insert:

```typescript
  // Auto-rebase onto main before read-only (evaluation) steps to prevent stale-base failures
  if (step.sandbox === "read-only" && settingsGet("rebase_before_eval") && task.worktree_path) {
    try {
      const { rebaseOnMain } = await import("../shared/worktree");
      const treeConfig = tree.config ? JSON.parse(tree.config) : {};
      const result = rebaseOnMain(task.worktree_path, treeConfig.default_branch);

      if (result.ok) {
        db.addEvent(task.id, null, "rebase_completed", "Rebased onto latest main before evaluation");
      } else {
        const files = result.conflictFiles?.join(", ") ?? "unknown";
        const msg = `Rebase conflict with main before "${step.id}" step — conflicting files: ${files}`;
        db.addEvent(task.id, null, "rebase_conflict", msg);
        onStepComplete(task.id, "failure", msg);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.addEvent(task.id, null, "rebase_failed", `Rebase error: ${msg}`);
      // Non-fatal — proceed without rebase rather than blocking evaluation
    }
  }
```

- [ ] **Step 2: Verify build passes**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun run build`
Expected: Clean build, no type errors

- [ ] **Step 3: Commit**

```bash
git add src/engine/step-engine.ts
git commit -m "feat: (W-078) auto-rebase worktree onto main before read-only eval steps"
```

---

### Task 4: Add step engine integration tests for rebase behavior

**Files:**
- Modify: `tests/engine/step-engine.test.ts`

- [ ] **Step 1: Add rebase tests to the step engine test suite**

Add a new `describe("rebase before eval")` block at the end of `tests/engine/step-engine.test.ts`. These tests verify the step engine correctly calls rebase before read-only steps and handles the result.

The existing test file mocks `../../src/broker/config` and `../../src/agents/worker`. We also need to mock `../../src/shared/worktree` to control `rebaseOnMain` behavior, and mock `settingsGet` to control the setting.

Since the step engine uses dynamic `import("../shared/worktree")` inside `executeStep()`, we can mock that module. The existing mock pattern captures real modules first, then uses `mock.module()`.

Add before the dynamic imports (after the existing `_realWorker` capture, around line 188):

```typescript
const _realWorktree = await import("../../src/shared/worktree");

// Track rebaseOnMain calls for assertions
let mockRebaseResult: { ok: boolean; conflictFiles?: string[]; error?: string } = { ok: true };
const rebaseOnMainMock = mock(() => mockRebaseResult);

mock.module("../../src/shared/worktree", () => ({
  ..._realWorktree,
  rebaseOnMain: rebaseOnMainMock,
}));
```

Also update the config mock to allow controlling `rebase_before_eval`:

```typescript
let mockRebaseBeforeEval = true;

mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => TEST_PATHS,
  settingsGet: (key: string) => {
    if (key === "rebase_before_eval") return mockRebaseBeforeEval;
    return (_realConfig as any).settingsGet(key);
  },
}));
```

Then add the test describe block at the bottom of the file:

```typescript
// ---------------------------------------------------------------------------
// Rebase before eval tests (W-078)
// ---------------------------------------------------------------------------

describe("rebase before eval", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
    _setDb(db);
    rebaseOnMainMock.mockClear();
    mockRebaseResult = { ok: true };
    mockRebaseBeforeEval = true;
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  function createTaskAt(
    id: string,
    step: string,
    stepIndex: number,
    opts: { worktree_path?: string; path_name?: string } = {},
  ) {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, worktree_path)
       VALUES (?, ?, 'active', 'tree-1', ?, ?, ?, ?)`,
      [
        id,
        `Task ${id}`,
        opts.path_name ?? "development",
        step,
        stepIndex,
        opts.worktree_path ?? "/tmp/test-tree/.grove/worktrees/" + id,
      ],
    );
  }

  test("calls rebaseOnMain before read-only step", async () => {
    createTaskAt("T-400", "review", 2);
    const task = db.taskGet("T-400")!;
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);
    // executeStep is async — wait for it
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).toHaveBeenCalled();

    // Verify rebase_completed event was logged
    const events = db.eventsByTask("T-400");
    const rebaseEvent = events.find((e) => e.event_type === "rebase_completed");
    expect(rebaseEvent).toBeDefined();
  });

  test("does not call rebaseOnMain for read-write steps", async () => {
    createTaskAt("T-401", "plan", 0);
    const task = db.taskGet("T-401")!;
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });

  test("does not call rebaseOnMain when setting is disabled", async () => {
    mockRebaseBeforeEval = false;
    createTaskAt("T-402", "review", 2);
    const task = db.taskGet("T-402")!;
    const tree = db.treeGet("tree-1")!;

    startPipeline(task, tree, db);
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });

  test("rebase conflict fails the step with context", async () => {
    mockRebaseResult = {
      ok: false,
      conflictFiles: ["src/index.ts", "package.json"],
      error: "rebase conflict with origin/main",
    };
    createTaskAt("T-403", "review", 2);
    const task = db.taskGet("T-403")!;
    const tree = db.treeGet("tree-1")!;

    // Manually trigger executeStep via resumePipeline for the review step
    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    // Should have logged a rebase_conflict event
    const events = db.eventsByTask("T-403");
    const conflictEvent = events.find((e) => e.event_type === "rebase_conflict");
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.summary).toContain("src/index.ts");
    expect(conflictEvent!.summary).toContain("package.json");

    // The step should have failed, transitioning back to implement (review's on_failure)
    const updated = db.taskGet("T-403")!;
    expect(updated.current_step).toBe("implement");
  });

  test("does not call rebaseOnMain when worktree_path is null", async () => {
    db.run(
      `INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index, worktree_path)
       VALUES (?, ?, 'active', 'tree-1', 'development', 'review', 2, NULL)`,
      ["T-404", "Task T-404"],
    );
    const task = db.taskGet("T-404")!;
    const tree = db.treeGet("tree-1")!;

    resumePipeline(task, tree, db, "review");
    await new Promise((r) => setTimeout(r, 50));

    expect(rebaseOnMainMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun test tests/engine/step-engine.test.ts`
Expected: All tests PASS (including existing + new rebase tests)

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove/.grove/worktrees/W-078 && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/engine/step-engine.test.ts
git commit -m "test: (W-078) add integration tests for rebase-before-eval in step engine"
```

---

## Design Decisions

### Which steps trigger the rebase?
Steps with `sandbox: "read-only"` — these are the evaluation/review gates. Read-only steps run tests and check code quality. Stale worktrees cause phantom failures here because the diff against main includes files from other merged PRs.

Read-write steps (implement, merge) don't need this because:
- Implement steps produce code — a stale base just means the worker works on an older snapshot, which the review step will catch anyway
- Merge steps push and create PRs — GitHub's merge mechanism handles the base branch automatically

### Why fail the step on conflict instead of fatal?
A rebase conflict means the implement step's changes conflict with recently merged work. Failing with `"failure"` outcome routes through the step's `on_failure` path (typically back to `implement`), giving the worker a chance to resolve conflicts on retry. A `"fatal"` would kill the entire task, which is too aggressive for a recoverable situation.

### Why catch errors non-fatally?
The `try/catch` around the rebase call logs the error but lets the step proceed. If `rebaseOnMain` throws (e.g., git not found, worktree corrupted), it's better to attempt evaluation on a potentially stale base than to block the entire pipeline. The evaluation step will catch real problems.

### Why dynamic import for worktree?
The step engine already uses dynamic imports (`await import(...)`) for `worker` and `dispatch` modules to avoid circular dependencies. Following the same pattern for `worktree` keeps the codebase consistent.
