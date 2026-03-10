# Batch Dispatch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `grove work --batch N` to dispatch N tasks in parallel with a live status monitor.

**Architecture:** All changes are in `src/commands/work.ts`. Add `--batch N` arg parsing, dispatch all N tasks via the existing `dispatchTask(id, false)` (background mode), then enter a poll loop that reads task status from DB every 3 seconds and renders a compact ANSI table. Reuse ANSI patterns from `dashboard.ts`.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test, ANSI escape codes

---

### Task 1: Add batch arg parsing and validation

**Files:**
- Modify: `src/commands/work.ts:476-495` (arg parsing block)
- Test: `tests/commands/work.test.ts`

**Step 1: Write the failing tests**

Add these tests to `tests/commands/work.test.ts` inside a new `describe("batch dispatch validation")` block:

```typescript
describe("batch dispatch validation", () => {
  test("--batch requires a positive integer", () => {
    const parseN = (s: string): number | null => {
      const n = parseInt(s, 10);
      if (isNaN(n) || n < 1) return null;
      return n;
    };
    expect(parseN("5")).toBe(5);
    expect(parseN("0")).toBeNull();
    expect(parseN("-1")).toBeNull();
    expect(parseN("abc")).toBeNull();
    expect(parseN("3.5")).toBe(3);
  });

  test("batch selects top N tasks by priority", async () => {
    for (let i = 1; i <= 5; i++) {
      db.exec(
        "INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
        [`W-${String(i).padStart(3, "0")}`, "manual", `Task ${i}`, "ready", "wheels", i],
      );
    }

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const tasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [3],
    );
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("W-001");
    expect(tasks[2].id).toBe("W-003");
  });

  test("batch capped by max_concurrent", async () => {
    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const maxConcurrent = settingsGet("max_concurrent") || 4;
    expect(maxConcurrent).toBe(4);
    expect(Math.min(10, maxConcurrent)).toBe(4);
  });

  test("batch capped by available tasks", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Only task", "ready", "wheels"],
    );

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const tasks = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [5],
    );
    expect(tasks).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/commands/work.test.ts`
Expected: All new tests PASS

**Step 3: Add `--batch` arg parsing to `work.ts`**

In `src/commands/work.ts`, modify the arg parsing block (lines 476-495). Add a `batchSize` variable and handle `--batch`:

Add `let batchSize = 0;` alongside existing variables (line 471-473).

Inside the while loop (after the `--run` check around line 484), add:

```typescript
} else if (arg === "--batch") {
  const val = args[++i] || "";
  batchSize = parseInt(val, 10);
  if (isNaN(batchSize) || batchSize < 1) {
    ui.die("--batch requires a positive integer (e.g., --batch 5)");
  }
} else if (arg.startsWith("--batch=")) {
  batchSize = parseInt(arg.slice("--batch=".length), 10);
  if (isNaN(batchSize) || batchSize < 1) {
    ui.die("--batch requires a positive integer (e.g., --batch 5)");
  }
```

Add validation after parsing loop closes (before line 498):

```typescript
if (batchSize > 0 && taskId) {
  ui.die("--batch cannot be used with a specific task ID.");
}
if (batchSize > 0 && repoFilter) {
  ui.die("--batch cannot be used with --repo.");
}
```

**Step 4: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/commands/work.ts tests/commands/work.test.ts
git commit -m "feat: add --batch arg parsing to work command"
```

---

### Task 2: Add the `renderBatchStatus` helper function

**Files:**
- Modify: `src/commands/work.ts` (add function before the command export, around line 459)
- Test: `tests/commands/work.test.ts`

**Step 1: Write the test**

Add to `tests/commands/work.test.ts`:

```typescript
describe("batch status rendering", () => {
  test("formatElapsed returns human-readable duration", () => {
    const formatElapsed = (startedAt: string): string => {
      const dt = new Date(startedAt.replace(" ", "T") + (startedAt.includes("Z") ? "" : "Z"));
      if (isNaN(dt.getTime())) return "-";
      const totalSecs = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
      const m = Math.floor(totalSecs / 60);
      const s = totalSecs % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const past = new Date(Date.now() - 90_000).toISOString().replace("T", " ").slice(0, 19);
    const result = formatElapsed(past);
    expect(result).toBe("1:30");
  });

  test("batch summary counts statuses correctly", () => {
    const statuses = ["running", "running", "done", "failed", "running"];
    const counts = { running: 0, done: 0, failed: 0 };
    for (const s of statuses) {
      if (s === "running") counts.running++;
      else if (s === "done" || s === "completed" || s === "review") counts.done++;
      else if (s === "failed") counts.failed++;
    }
    expect(counts.running).toBe(3);
    expect(counts.done).toBe(1);
    expect(counts.failed).toBe(1);
  });
});
```

**Step 2: Run test**

Run: `~/.bun/bin/bun test tests/commands/work.test.ts`
Expected: PASS

**Step 3: Write `renderBatchStatus` and helpers in `work.ts`**

Add these functions above the `workCommand` export (around line 459):

```typescript
// ---------------------------------------------------------------------------
// Batch monitor helpers
// ---------------------------------------------------------------------------

const ANSI = {
  up: (n: number) => `\x1b[${n}A`,
  clearLine: "\x1b[2K",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "-";
  const dt = new Date(
    startedAt.replace(" ", "T") +
    (startedAt.includes("Z") || startedAt.includes("+") ? "" : "Z")
  );
  if (isNaN(dt.getTime())) return "-";
  const totalSecs = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function batchStatusIcon(status: string): string {
  switch (status) {
    case "running": return `${ANSI.green}⚙${ANSI.reset}`;
    case "done": case "completed": case "review":
      return `${ANSI.green}✓${ANSI.reset}`;
    case "failed": return `${ANSI.red}✗${ANSI.reset}`;
    default: return `${ANSI.dim}·${ANSI.reset}`;
  }
}

function batchStatusLabel(status: string): string {
  switch (status) {
    case "running": return `${ANSI.green}running${ANSI.reset}`;
    case "done": case "completed": case "review":
      return `${ANSI.green}done${ANSI.reset}`;
    case "failed": return `${ANSI.red}failed${ANSI.reset}`;
    default: return `${ANSI.dim}${status}${ANSI.reset}`;
  }
}

/**
 * Render a compact batch status table. Returns number of lines written.
 * On subsequent calls, moves cursor up to overwrite previous render.
 */
function renderBatchStatus(taskIds: string[], isFirst: boolean): void {
  const db = getDb();
  const lineCount = taskIds.length + 2; // tasks + blank + summary

  if (!isFirst) {
    process.stdout.write(ANSI.up(lineCount));
  }

  let running = 0, done = 0, failed = 0, totalCost = 0;

  for (const id of taskIds) {
    const task = db.taskGet(id);
    if (!task) {
      process.stdout.write(ANSI.clearLine + `  ? ${id} (not found)\n`);
      continue;
    }

    const icon = batchStatusIcon(task.status);
    const label = batchStatusLabel(task.status);
    const repo = (task.repo ?? "-").padEnd(12);
    const title = task.title.length > 30
      ? task.title.slice(0, 27) + "..."
      : task.title.padEnd(30);
    const elapsed = formatElapsed(task.started_at);
    const cost = task.cost_usd > 0 ? `  $${task.cost_usd.toFixed(2)}` : "";

    if (task.status === "running") running++;
    else if (["done", "completed", "review"].includes(task.status)) done++;
    else if (task.status === "failed") failed++;
    totalCost += task.cost_usd || 0;

    process.stdout.write(
      ANSI.clearLine +
      `  ${icon} ${ANSI.bold}${id.padEnd(8)}${ANSI.reset} ${repo} ${title} ${label}  ${ANSI.dim}${elapsed}${ANSI.reset}${cost}\n`
    );
  }

  const parts = [
    running > 0 ? `${running} running` : "",
    done > 0 ? `${done} done` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
  const costStr = totalCost > 0 ? ` · $${totalCost.toFixed(2)} total` : "";

  process.stdout.write(ANSI.clearLine + "\n");
  process.stdout.write(ANSI.clearLine + `  ${parts}${costStr}\n`);
}
```

**Step 4: Run tests**

Run: `~/.bun/bin/bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/commands/work.ts tests/commands/work.test.ts
git commit -m "feat: add batch status rendering helpers"
```

---

### Task 3: Wire `--batch` into the command entry point

**Files:**
- Modify: `src/commands/work.ts` (inside `run()`, before Mode 1)
- Test: `tests/commands/work.test.ts`

**Step 1: Write the integration test**

Add to `tests/commands/work.test.ts`:

```typescript
describe("batch dispatch end-to-end", () => {
  test("batch selects only ready/planned tasks and ignores others", async () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "manual", "Ready 1", "ready", "wheels", 1]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-002", "manual", "Ready 2", "ready", "wheels", 2]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "manual", "Running", "running", "wheels", 3]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, repo, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-004", "manual", "Done", "done", "wheels", 4]);

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const batch = testDb.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
      [10],
    );
    expect(batch.map(t => t.id)).toEqual(["W-001", "W-002"]);
  });

  test("terminal states are correctly identified", () => {
    const TERMINAL = new Set(["done", "completed", "failed", "review"]);
    expect(TERMINAL.has("done")).toBe(true);
    expect(TERMINAL.has("completed")).toBe(true);
    expect(TERMINAL.has("failed")).toBe(true);
    expect(TERMINAL.has("review")).toBe(true);
    expect(TERMINAL.has("running")).toBe(false);
    expect(TERMINAL.has("paused")).toBe(false);
  });
});
```

**Step 2: Run test**

Run: `~/.bun/bin/bun test tests/commands/work.test.ts`
Expected: PASS

**Step 3: Add batch dispatch logic to `run()`**

In `src/commands/work.ts`, add a new block after the incompatibility checks and before `// --- Mode 1: Specific task ID ---`:

```typescript
// --- Mode 0: Batch dispatch ---
if (batchSize > 0) {
  const maxConcurrent = settingsGet("max_concurrent") || 4;
  const weekCost = db.costWeek();
  const weekBudget = budgetGet("per_week");

  // Select top N from queue
  const candidates = db.all<Task>(
    "SELECT * FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT ?",
    [batchSize],
  );

  if (candidates.length === 0) {
    ui.info("No tasks ready to dispatch.");
    return;
  }

  // Cap by max_concurrent (accounting for already-running tasks)
  const runningCount = db.taskCount("running");
  const slotsAvailable = Math.max(0, maxConcurrent - runningCount);

  if (slotsAvailable === 0) {
    ui.die(`All ${maxConcurrent} concurrent slots in use. Wait or increase max_concurrent.`);
  }

  let toDispatch = candidates.slice(0, slotsAvailable);
  if (toDispatch.length < candidates.length) {
    ui.warn(`Capped to ${toDispatch.length} (${runningCount} already running, max ${maxConcurrent}).`);
  }

  // Budget warning
  if (weekBudget > 0) {
    const totalEstimated = toDispatch.reduce((sum, t) => sum + (t.estimated_cost ?? 0), 0);
    const remaining = weekBudget - weekCost;
    if (totalEstimated > remaining) {
      ui.warn(`Estimated cost $${totalEstimated.toFixed(2)} exceeds remaining budget $${remaining.toFixed(2)}.`);
    }
  }

  // Dispatch all in background
  ui.header(`Dispatching ${toDispatch.length} task(s)`);
  const dispatchedIds: string[] = [];

  for (const task of toDispatch) {
    const exitCode = await dispatchTask(task.id, false);
    if (exitCode === 0) {
      dispatchedIds.push(task.id);
    } else {
      ui.warn(`Failed to dispatch ${task.id}`);
    }
  }

  if (dispatchedIds.length === 0) {
    ui.error("No tasks were dispatched.");
    return;
  }

  console.log();

  // Live monitor loop
  const TERMINAL = new Set(["done", "completed", "failed", "review"]);
  const POLL_MS = 3_000;

  process.stdout.write(ANSI.hideCursor);

  const cleanup = () => process.stdout.write(ANSI.showCursor);
  const onSig = () => {
    cleanup();
    console.log(`\n  Detached. Workers continue in background.`);
    console.log(`  Use ${ui.bold("grove dashboard")} or ${ui.bold("grove watch TASK_ID")} to monitor.\n`);
    process.exit(0);
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  let isFirst = true;
  while (true) {
    renderBatchStatus(dispatchedIds, isFirst);
    isFirst = false;

    const allDone = dispatchedIds.every((id) => {
      const t = db.taskGet(id);
      return t && TERMINAL.has(t.status);
    });
    if (allDone) break;

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  cleanup();
  process.removeListener("SIGINT", onSig);
  process.removeListener("SIGTERM", onSig);

  // Final summary
  console.log();
  let batchDone = 0, batchFailed = 0, batchCost = 0;
  for (const id of dispatchedIds) {
    const t = db.taskGet(id);
    if (!t) continue;
    if (t.status === "failed") batchFailed++;
    else batchDone++;
    batchCost += t.cost_usd || 0;
  }

  if (batchFailed === 0) {
    ui.success(`Batch complete: ${batchDone} task(s) finished. Cost: ${ui.dollars(batchCost)}`);
  } else {
    ui.warn(`Batch complete: ${batchDone} succeeded, ${batchFailed} failed. Cost: ${ui.dollars(batchCost)}`);
  }
  return;
}
```

**Step 4: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/commands/work.ts tests/commands/work.test.ts
git commit -m "feat: wire --batch into work command with live monitor"
```

---

### Task 4: Update help text and final verification

**Files:**
- Modify: `src/commands/work.ts:630-658` (help function)

**Step 1: Update the help text**

Replace the `help()` return value with:

```typescript
return `Usage: grove work [TASK_ID] [--repo NAME] [--batch N]

Dispatch a Claude Code worker session for a task.

Modes:
  grove work TASK_ID       Start a specific task (foreground)
  grove work --repo NAME   Pick the next ready task for a repo
  grove work --batch N     Dispatch top N tasks in parallel
  grove work               Show ready tasks, choose interactively
  grove run TASK_ID        Non-interactive mode (auto-pick, no prompts)

What happens:
  1. Creates a git worktree for the task
  2. Deploys sandbox (guard hooks + CLAUDE.md overlay)
  3. Spawns "claude -p" with stream-json output
  4. Captures session summary, cost, and files modified
  5. Auto-publishes (push + draft PR) on success

Options:
  --repo NAME    Filter to tasks for a specific repo
  --batch N      Dispatch N tasks in parallel with live status monitor
  --run          Non-interactive mode (same as "grove run")

Batch mode:
  Selects top N tasks from the priority queue. All run in background.
  Displays a live status table until all tasks finish.
  Capped by max_concurrent setting and weekly budget.
  Ctrl+C detaches — workers continue in background.

Interactive mode: select multiple tasks to dispatch. The first runs in
foreground; the rest run in background up to max_concurrent.`;
```

**Step 2: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All tests pass (should be ~207+ tests)

**Step 3: Compile binary**

Run: `~/.bun/bin/bun build src/index.ts --compile --outfile bin/grove`
Expected: Compiles in <200ms

**Step 4: Verify help output**

Run: `./bin/grove work --help`
Expected: Shows updated help text with `--batch N`

**Step 5: Commit and push**

```bash
git add src/commands/work.ts
git commit -m "docs: update work command help with --batch flag"
git push
```
