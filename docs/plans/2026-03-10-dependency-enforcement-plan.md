# Dependency Enforcement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent dispatch of tasks whose dependencies haven't completed, and notify when tasks become unblocked.

**Architecture:** Add two helper methods to Database class (`isTaskBlocked`, `getNewlyUnblocked`), wire them into `add.ts` (new `--depends` flag), `work.ts` (dispatch gate + unblock notification), and `hud.ts` (reuse shared helper). All changes in existing files — no new modules.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test

---

### Task 1: Shared dependency helpers in Database class

**Files:**
- Modify: `src/core/db.ts:76-138` (task helpers section)
- Test: `tests/core/db.test.ts`

**Context:** The HUD command (hud.ts:212-217) already has inline blocked-check logic. We're extracting this into reusable Database methods so work.ts and hud.ts can share it. The `depends_on` column stores comma-separated task IDs like `"W-001,W-002"`. A task is blocked when any dependency has a status other than `done` or `completed`.

**Step 1: Write the failing tests**

Add to `tests/core/db.test.ts`:

```typescript
describe("dependency helpers", () => {
  test("isTaskBlocked returns false when depends_on is null", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "No deps", "ready", "testrepo"],
    );
    expect(db.isTaskBlocked("W-001")).toBe(false);
  });

  test("isTaskBlocked returns true when dependency is not done", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "running", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Blocked task", "ready", "testrepo", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(true);
  });

  test("isTaskBlocked returns false when all deps are done", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Done task", "done", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked", "ready", "testrepo", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("isTaskBlocked handles completed status", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Completed task", "completed", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked", "ready", "testrepo", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("isTaskBlocked with multiple deps — one incomplete", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Done", "done", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Still running", "running", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Blocked", "ready", "testrepo", "W-001,W-002"],
    );
    expect(db.isTaskBlocked("W-003")).toBe(true);
  });

  test("isTaskBlocked returns true when dep task doesn't exist", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Orphan dep", "ready", "testrepo", "NONEXISTENT"],
    );
    expect(db.isTaskBlocked("W-001")).toBe(true);
  });

  test("getNewlyUnblocked returns tasks whose deps are now all met", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Just completed", "done", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Was blocked", "ready", "testrepo", "W-001"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].id).toBe("W-002");
  });

  test("getNewlyUnblocked excludes tasks still blocked by other deps", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Just completed", "done", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Still running", "running", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Still blocked", "ready", "testrepo", "W-001,W-002"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked).toHaveLength(0);
  });

  test("getNewlyUnblocked ignores terminal tasks", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Just completed", "done", "testrepo"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Already done", "done", "testrepo", "W-001"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/core/db.test.ts`
Expected: FAIL with `db.isTaskBlocked is not a function`

**Step 3: Implement the helpers**

Add to `src/core/db.ts` in the task helpers section (after `taskExists`, around line 138):

```typescript
  isTaskBlocked(taskId: string): boolean {
    const task = this.taskGet(taskId);
    if (!task?.depends_on) return false;
    const deps = task.depends_on.split(",").map((d) => d.trim()).filter(Boolean);
    if (deps.length === 0) return false;
    return deps.some((dep) => {
      const depTask = this.taskGet(dep);
      return !depTask || (depTask.status !== "done" && depTask.status !== "completed");
    });
  }

  getNewlyUnblocked(completedTaskId: string): Task[] {
    const candidates = this.all<Task>(
      `SELECT * FROM tasks
       WHERE depends_on LIKE ? AND status NOT IN ('done', 'completed', 'failed')`,
      [`%${completedTaskId}%`],
    );
    return candidates.filter((t) => !this.isTaskBlocked(t.id));
  }
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/core/db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/db.ts tests/core/db.test.ts
git commit -m "feat: add isTaskBlocked and getNewlyUnblocked helpers to Database"
```

---

### Task 2: --depends flag on grove add

**Files:**
- Modify: `src/commands/add.ts:17-37` (arg parsing), `src/commands/add.ts:100-105` (INSERT), `src/commands/add.ts:130-149` (help)
- Test: `tests/commands/add.test.ts`

**Context:** The add command creates tasks via SQL INSERT. Currently it doesn't set `depends_on`. We add `--depends W-001,W-002` flag that validates the referenced IDs exist and stores the value.

**Step 1: Write the failing tests**

Add to `tests/commands/add.test.ts` inside the `describe("addCommand")` block:

```typescript
  test("--depends stores dependency on task", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Dep target", "ready", "wheels"],
    );

    await resetModules();
    const { addCommand } = await import("../../src/commands/add");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true, configurable: true });

    try {
      await addCommand.run(["Follow-up task", "--repo", "wheels", "--depends", "W-001"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-002");
    expect(task).not.toBeNull();
    expect(task!.depends_on).toBe("W-001");
    verifyDb.close();
  });

  test("--depends with multiple IDs", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Dep 1", "ready", "wheels"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Dep 2", "ready", "wheels"],
    );

    await resetModules();
    const { addCommand } = await import("../../src/commands/add");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true, configurable: true });

    try {
      await addCommand.run(["Depends on two", "--repo", "wheels", "--depends", "W-001,W-002"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }

    const verifyDb = new Database(join(tempDir, "grove.db"));
    const task = verifyDb.taskGet("W-003");
    expect(task).not.toBeNull();
    expect(task!.depends_on).toBe("W-001,W-002");
    verifyDb.close();
  });
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/commands/add.test.ts`
Expected: FAIL — task has no depends_on value

**Step 3: Implement --depends in add.ts**

Add `depends` variable at line 17 and parsing in the while loop:

```typescript
    let description = "";
    let repo = "";
    let depends = "";
```

Add to arg parsing (after the `--repo=` branch):

```typescript
      } else if (arg === "--depends" && i + 1 < args.length) {
        depends = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--depends=")) {
        depends = arg.slice("--depends=".length);
        i++;
```

After repo validation (line 94), add dep validation:

```typescript
    if (depends) {
      const depIds = depends.split(",").map((d) => d.trim()).filter(Boolean);
      for (const depId of depIds) {
        if (!db.taskExists(depId)) {
          ui.die(`Dependency not found: ${depId}`);
        }
      }
    }
```

Update the INSERT to include depends_on:

```typescript
    db.exec(
      `INSERT INTO tasks (id, repo, source_type, title, description, status, priority, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, repo, SourceType.Manual, description, description, "ingested", 50, depends || null],
    );
```

Update help text to document the flag:

```typescript
  help() {
    return [
      "Usage: grove add [DESCRIPTION] [--repo NAME] [--depends IDS]",
      "",
      "Create a new task. Two modes:",
      "",
      '  Quick:       grove add "Fix route parsing" --repo wheels',
      "  Interactive: grove add",
      "",
      "Options:",
      "  --repo NAME        Assign to a specific repository",
      "  --depends IDS      Comma-separated task IDs this depends on",
      "",
      "Dependencies prevent dispatch until all listed tasks complete.",
      "",
      'The task starts in "ingested" status. Run "grove plan TASK"',
      'to assign a strategy, or "grove work TASK" to start immediately.',
    ].join("\n");
  },
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/add.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/add.ts tests/commands/add.test.ts
git commit -m "feat: add --depends flag to grove add command"
```

---

### Task 3: Dispatch gate in work.ts

**Files:**
- Modify: `src/commands/work.ts`
- Test: `tests/commands/work.test.ts`

**Context:** Four dispatch modes need dependency checking. The simplest approach: add a blocked check inside `dispatchTask()` (catches all callers including Mode 1 specific task ID), then additionally filter candidate lists in batch/interactive/repo modes so blocked tasks don't appear as options.

**Step 1: Write the failing tests**

Add to `tests/commands/work.test.ts`:

```typescript
describe("dependency enforcement", () => {
  test("blocked tasks excluded from batch candidate list", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "running", "wheels", 1],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Blocked task", "ready", "wheels", 2, "W-001"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Free task", "ready", "wheels", 3],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const candidates = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [10],
    );
    const filtered = candidates.filter((t) => !testDb.isTaskBlocked(t.id));
    expect(filtered.map((t) => t.id)).toEqual(["W-003"]);
  });

  test("task with all deps done is not blocked", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Done dep", "done", "wheels"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked", "ready", "wheels", "W-001"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.isTaskBlocked("W-002")).toBe(false);
  });

  test("dispatchTask rejects blocked task", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "running", "wheels", 1],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Blocked", "ready", "wheels", 2, "W-001"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.isTaskBlocked("W-002")).toBe(true);
    const task = testDb.taskGet("W-002")!;
    const deps = task.depends_on!.split(",").map((d) => d.trim()).filter(Boolean);
    const pendingDeps = deps.filter((dep) => {
      const dt = testDb.taskGet(dep);
      return !dt || (dt.status !== "done" && dt.status !== "completed");
    });
    expect(pendingDeps).toEqual(["W-001"]);
  });

  test("interactive mode separates blocked from available", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Running dep", "running", "wheels", 1],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Blocked", "ready", "wheels", 2, "W-001"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Available", "ready", "wheels", 3],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const readyTasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 20",
    );
    const available = readyTasks.filter((t) => !testDb.isTaskBlocked(t.id));
    const blocked = readyTasks.filter((t) => testDb.isTaskBlocked(t.id));

    expect(available.map((t) => t.id)).toEqual(["W-003"]);
    expect(blocked.map((t) => t.id)).toEqual(["W-002"]);
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `bun test tests/commands/work.test.ts`
Expected: PASS (these tests verify the helper logic which was added in Task 1)

**Step 3: Implement dispatch gate in work.ts**

**3a. Blocked check in `dispatchTask()` — add after line 117 (task null check), before the status switch:**

```typescript
  // -- Pre-flight: dependency check --
  if (db.isTaskBlocked(taskId)) {
    const deps = (task.depends_on ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const pendingDeps = deps.filter((dep) => {
      const dt = db.taskGet(dep);
      return !dt || (dt.status !== "done" && dt.status !== "completed");
    });
    ui.warn(`Skipping ${taskId}: blocked by ${pendingDeps.join(", ")}`);
    return 1;
  }
```

**3b. Filter in batch mode (Mode 0) — replace lines 628-631:**

Change the candidate query to fetch extra, then filter:

```typescript
      const allCandidates = db.all<Task>(
        "SELECT * FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
        [batchSize * 2],
      );

      const blockedIds: string[] = [];
      const candidates = allCandidates.filter((t) => {
        if (db.isTaskBlocked(t.id)) {
          blockedIds.push(t.id);
          return false;
        }
        return true;
      });

      if (blockedIds.length > 0) {
        for (const id of blockedIds) {
          const bt = db.taskGet(id);
          ui.warn(`Skipping ${id}: blocked by ${bt?.depends_on}`);
        }
      }

      if (candidates.length === 0) {
        ui.info("No tasks ready to dispatch.");
        return;
      }
```

**3c. Filter in repo mode (Mode 2) — after the candidate lookup (line 746-751):**

```typescript
      if (!next) {
        ui.info(`No ready tasks for repo: ${repoFilter}`);
        return;
      }
      if (db.isTaskBlocked(next.id)) {
        ui.warn(`Skipping ${next.id}: blocked by dependencies`);
        return;
      }
```

**3d. Filter in interactive mode (Mode 3) — after fetching readyTasks (line 762-770):**

Replace with:

```typescript
    const allReady = db.all<Task>(
      "SELECT id, repo, title, estimated_cost, depends_on FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 20"
    );

    const readyTasks = allReady.filter((t) => !db.isTaskBlocked(t.id));
    const blockedTasks = allReady.filter((t) => db.isTaskBlocked(t.id));

    if (readyTasks.length === 0 && blockedTasks.length === 0) {
      ui.info("No tasks ready to work on.");
      console.log(`  Run ${ui.bold("grove add")} to create a task, or ${ui.bold("grove sync")} to pull from GitHub.`);
      return;
    }

    if (readyTasks.length === 0) {
      ui.info("All ready tasks are blocked by dependencies.");
      for (const t of blockedTasks) {
        console.log(`  ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)} ${ui.dim(`blocked by ${t.depends_on}`)}`);
      }
      return;
    }
```

Then after the numbered task list, show blocked tasks:

```typescript
    if (blockedTasks.length > 0) {
      console.log();
      console.log(`  ${ui.dim("Blocked:")}`);
      for (const t of blockedTasks) {
        console.log(`    ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)} ${ui.dim(`waiting on ${t.depends_on}`)}`);
      }
    }
```

**Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/commands/work.ts tests/commands/work.test.ts
git commit -m "feat: add dependency enforcement gate to all dispatch modes"
```

---

### Task 4: Unblock notification on task completion

**Files:**
- Modify: `src/commands/work.ts`
- Test: `tests/commands/work.test.ts`

**Context:** When a task completes, check if any blocked tasks are now unblocked. Two completion paths: foreground (line 358) and background (line 439). Extract a `notifyUnblocked()` helper.

**Step 1: Write the failing tests**

Add to `tests/commands/work.test.ts`:

```typescript
describe("unblock notification", () => {
  test("getNewlyUnblocked finds tasks freed by completion", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Just finished", "done", "wheels"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Was waiting", "ready", "wheels", "W-001"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const unblocked = testDb.getNewlyUnblocked("W-001");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].id).toBe("W-002");
  });

  test("getNewlyUnblocked returns empty when no dependents", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Standalone", "done", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    expect(testDb.getNewlyUnblocked("W-001")).toHaveLength(0);
  });

  test("dependency_met event logged for unblocked tasks", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Completed", "done", "wheels"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, depends_on) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked", "ready", "wheels", "W-001"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const unblocked = testDb.getNewlyUnblocked("W-001");
    for (const t of unblocked) {
      testDb.addEvent(t.id, "dependency_met", `Unblocked by W-001`);
    }

    const events = testDb.all<{ task_id: string; event_type: string; summary: string }>(
      "SELECT task_id, event_type, summary FROM events WHERE event_type = 'dependency_met'",
    );
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe("W-002");
    expect(events[0].summary).toContain("W-001");
  });
});
```

**Step 2: Run tests**

Run: `bun test tests/commands/work.test.ts`
Expected: PASS (tests exercise db helpers directly)

**Step 3: Implement notifyUnblocked**

Add helper after `getFilesModified` (around line 97):

```typescript
function notifyUnblocked(taskId: string): void {
  const db = getDb();
  const unblocked = db.getNewlyUnblocked(taskId);
  for (const t of unblocked) {
    db.addEvent(t.id, "dependency_met", `Unblocked by ${taskId}`);
    ui.info(`Unblocked: ${t.id} (${t.title})`);
  }
}
```

Wire into foreground completion — after `ui.success('Task ${taskId} completed.')` (line 362):

```typescript
      notifyUnblocked(taskId);
```

Wire into background completion — after `db.sessionEnd(sessionId, "completed")` (line 441):

```typescript
        notifyUnblocked(taskId);
```

**Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/commands/work.ts tests/commands/work.test.ts
git commit -m "feat: notify when tasks become unblocked after dependency completes"
```

---

### Task 5: Refactor hud.ts to use shared helper

**Files:**
- Modify: `src/commands/hud.ts:202-224`

**Context:** HUD has inline blocked-check logic duplicating `db.isTaskBlocked()`. Pure refactor, no behavior change.

**Step 1: Refactor**

Replace the inline loop (lines 211-224):

```typescript
    const blockedLines: string[] = [];
    for (const t of blockedCandidates) {
      if (db.isTaskBlocked(t.id)) {
        blockedLines.push(
          `    ${ui.badge("blocked", "red")} ${ui.dim(t.id)} ${ui.dim(t.repo ?? "")}  ${ui.truncate(t.title, 44)}`,
        );
        blockedLines.push(`      ${ui.dim(`Waiting on: ${t.depends_on}`)}`);
      }
    }
```

**Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/commands/hud.ts
git commit -m "refactor: use shared isTaskBlocked helper in hud command"
```

---

### Task 6: Update help text in work.ts

**Files:**
- Modify: `src/commands/work.ts:868-901` (help function)

**Step 1: Add dependency section to help**

Add after the Options section:

```
Dependencies:
  Tasks with --depends are skipped until all dependencies complete.
  Use "grove add --depends W-001,W-002" to set dependencies.
  Blocked tasks show a warning when skipped during dispatch.
```

**Step 2: Commit**

```bash
git add src/commands/work.ts
git commit -m "docs: add dependency info to work command help text"
```

---

## Unresolved Questions

- Should `grove plan` auto-detect dependencies from task descriptions? (Deferred)
- Add index on `depends_on` for LIKE queries? (Not needed until 100+ tasks)
