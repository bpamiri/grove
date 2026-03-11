# Automatic Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic retry for failed tasks in drain's poll loop, with configurable limits and per-task override.

**Architecture:** Two new columns on `tasks` (`retry_count`, `max_retries`). Drain detects failures, checks limits, re-enqueues retriable tasks. New `max_retries` setting with default 2. `grove add --max-retries N` for per-task override.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test

---

### Task 1: Add `retry_count` and `max_retries` to Task interface and schema

**Files:**
- Modify: `src/types.ts:68-98`
- Modify: `src/types.ts:26-45`
- Modify: `src/types.ts:165-170`
- Modify: `schema.sql:19-59`
- Modify: `src/core/db.ts:17-20`

**Step 1: Add retry fields to Task interface**

In `src/types.ts`, add two fields to the `Task` interface after the `depends_on` field (line 81):

```typescript
  depends_on: string | null;
  retry_count: number;
  max_retries: number | null;
```

**Step 2: Add event types to EventType enum**

In `src/types.ts`, add after `Detached = "detached"` (line 44):

```typescript
  AutoRetried = "auto_retried",
  RetryExhausted = "retry_exhausted",
```

**Step 3: Add `max_retries` to SettingsConfig**

In `src/types.ts`, add to `SettingsConfig` after `stall_timeout_minutes` (line 169):

```typescript
  max_retries: number;
```

**Step 4: Add columns to schema.sql**

In `schema.sql`, add two columns inside the tasks table after `depends_on TEXT,` (line 34):

```sql
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT NULL,
```

**Step 5: Add ALTER TABLE migration to db.ts**

In `src/core/db.ts`, modify the `init` method (line 17-20) to add the new columns if they don't exist. After `this.db.exec(sql);` add:

```typescript
    // Migrations: add columns if missing (idempotent)
    const cols = this.all<{ name: string }>("PRAGMA table_info(tasks)").map(c => c.name);
    if (!cols.includes("retry_count")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0");
    }
    if (!cols.includes("max_retries")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT NULL");
    }
```

**Step 6: Run tests**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All 241 tests pass. This is a type + schema change with no behavior change.

**Step 7: Commit**

```bash
git add src/types.ts schema.sql src/core/db.ts
git commit -m "feat: add retry_count, max_retries columns and event types"
```

---

### Task 2: Write drain retry tests

**Files:**
- Create: `tests/commands/drain-retry.test.ts`

**Step 1: Write the test file**

Follow the same pattern as `tests/commands/drain.test.ts` — temp dir, init DB with schema, grove.yaml with `max_retries: 2` in settings, repo record.

Tests to include:

**describe("drain retry logic")**

- `retries failed task up to max_retries` — Insert task with status=failed, retry_count=0. Check retry_count < effective_max (0 < 2). Simulate retry: increment retry_count, set status to "ready". Verify retry_count=1, status="ready".

- `stops retrying when retry_count reaches max` — Insert task with status=failed, retry_count=2. Verify retry_count >= effective_max (2 >= 2). Task stays "failed".

- `respects per-task max_retries=0 (no-retry)` — Insert task with max_retries=0. Effective max = 0. Verify no retry allowed.

- `per-task max_retries=5 allows more retries than global` — Insert task with retry_count=3, max_retries=5. Verify 3 < 5 allows retry.

- `logs auto_retried event on retry` — Insert task, simulate retry, verify events table has "auto_retried" event.

- `logs retry_exhausted event when max reached` — Insert task with retry_count=2, verify "retry_exhausted" event logged.

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");
const projectRoot = join(import.meta.dir, "../..");

let tempDir: string;
let db: Database;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-drain-retry-test-"));
  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;

  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  writeFileSync(
    join(tempDir, "grove.yaml"),
    `workspace:
  name: "Test"
repos:
  wheels:
    org: cfwheels
    github: cfwheels/wheels
    path: ~/code/wheels
budgets:
  per_task: 5
  per_session: 10
  per_day: 25
  per_week: 100
  auto_approve_under: 2
settings:
  max_concurrent: 4
  branch_prefix: "grove/"
  auto_sync: false
  max_retries: 2
`,
  );

  db.repoUpsert({
    name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels",
    local_path: "~/code/wheels", branch_prefix: "grove/",
    claude_md_path: null, last_synced: null,
  });
});

afterEach(() => {
  db.close();
  if (originalEnv.GROVE_HOME !== undefined) process.env.GROVE_HOME = originalEnv.GROVE_HOME;
  else delete process.env.GROVE_HOME;
  if (originalEnv.GROVE_ROOT !== undefined) process.env.GROVE_ROOT = originalEnv.GROVE_ROOT;
  else delete process.env.GROVE_ROOT;
  rmSync(tempDir, { recursive: true, force: true });
});

async function resetModules() {
  const { closeDb } = await import("../../src/core/db");
  closeDb();
  const config = await import("../../src/core/config");
  config.reloadConfig();
}

function insertTask(id: string, status: string, extra?: Record<string, any>) {
  const cols = ["id", "source_type", "title", "status", "repo"];
  const vals: any[] = [id, "manual", `Task ${id}`, status, "wheels"];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      cols.push(k);
      vals.push(v);
    }
  }
  const placeholders = cols.map(() => "?").join(", ");
  db.exec(
    `INSERT INTO tasks (${cols.join(", ")}) VALUES (${placeholders})`,
    vals,
  );
}

describe("drain retry logic", () => {
  test("retries failed task up to max_retries", async () => {
    insertTask("R-001", "failed", { retry_count: 0 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-001")!;
    const effectiveMax = task.max_retries ?? settingsGet("max_retries") ?? 2;

    expect(task.retry_count).toBe(0);
    expect(effectiveMax).toBe(2);
    expect(task.retry_count < effectiveMax).toBe(true);

    // Simulate drain retry
    testDb.exec(
      "UPDATE tasks SET retry_count = retry_count + 1, status = 'ready', updated_at = datetime('now') WHERE id = ?",
      ["R-001"],
    );
    testDb.addEvent("R-001", "auto_retried", "Auto-retry 1/2");

    const updated = testDb.taskGet("R-001")!;
    expect(updated.retry_count).toBe(1);
    expect(updated.status).toBe("ready");
  });

  test("stops retrying when retry_count reaches max", async () => {
    insertTask("R-002", "failed", { retry_count: 2 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-002")!;
    const effectiveMax = task.max_retries ?? settingsGet("max_retries") ?? 2;

    expect(task.retry_count).toBe(2);
    expect(effectiveMax).toBe(2);
    expect(task.retry_count < effectiveMax).toBe(false);
    expect(task.status).toBe("failed");
  });

  test("respects per-task max_retries=0 (no-retry)", async () => {
    insertTask("R-003", "failed", { retry_count: 0, max_retries: 0 });

    await resetModules();
    const { settingsGet } = await import("../../src/core/config");
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-003")!;
    const effectiveMax = task.max_retries ?? settingsGet("max_retries") ?? 2;

    expect(effectiveMax).toBe(0);
    expect(task.retry_count < effectiveMax).toBe(false);
  });

  test("per-task max_retries=5 allows more retries than global", async () => {
    insertTask("R-004", "failed", { retry_count: 3, max_retries: 5 });

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    const task = testDb.taskGet("R-004")!;
    const effectiveMax = task.max_retries ?? 2;

    expect(effectiveMax).toBe(5);
    expect(task.retry_count < effectiveMax).toBe(true);
  });

  test("logs auto_retried event on retry", async () => {
    insertTask("R-005", "failed", { retry_count: 0 });

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    testDb.exec(
      "UPDATE tasks SET retry_count = retry_count + 1, status = 'ready' WHERE id = ?",
      ["R-005"],
    );
    testDb.addEvent("R-005", "auto_retried", "Auto-retry 1/2");

    const events = testDb.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = ? AND event_type = 'auto_retried'",
      ["R-005"],
    );
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("Auto-retry");
  });

  test("logs retry_exhausted event when max reached", async () => {
    insertTask("R-006", "failed", { retry_count: 2 });

    await resetModules();
    const { getDb } = await import("../../src/core/db");
    const testDb = getDb();

    testDb.addEvent("R-006", "retry_exhausted", "Retry exhausted (2/2)");

    const events = testDb.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = ? AND event_type = 'retry_exhausted'",
      ["R-006"],
    );
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("exhausted");
  });
});
```

**Step 2: Run the tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/drain-retry.test.ts`
Expected: All 6 tests pass.

**Step 3: Commit**

```bash
git add tests/commands/drain-retry.test.ts
git commit -m "test: add drain retry logic tests"
```

---

### Task 3: Integrate retry logic into drain poll loop

**Files:**
- Modify: `src/commands/drain.ts:137` (add autoRetried to stats)
- Modify: `src/commands/drain.ts:198-228` (add retry before failed counting)
- Modify: `src/commands/drain.ts:255-276` (add auto-retried to summary)
- Modify: `src/commands/drain.ts:108-111` (add retry info to --dry-run)

**Step 1: Add autoRetried to stats object**

In `src/commands/drain.ts` line 137, change:

```typescript
    const stats = { totalDone: 0, totalFailed: 0, autoEnqueued: 0, startTime: Date.now() };
```

To:

```typescript
    const stats = { totalDone: 0, totalFailed: 0, autoEnqueued: 0, autoRetried: 0, startTime: Date.now() };
```

**Step 2: Add retry logic in the terminal-status check**

In `src/commands/drain.ts`, replace the failed branch (lines 203-204):

```typescript
            if (task.status === "failed") {
              stats.totalFailed++;
```

With:

```typescript
            if (task.status === "failed") {
              const effectiveMax = task.max_retries ?? settingsGet("max_retries") ?? 2;
              if (task.retry_count < effectiveMax) {
                const newCount = (task.retry_count ?? 0) + 1;
                db.exec("UPDATE tasks SET retry_count = retry_count + 1, status = 'ready', updated_at = datetime('now') WHERE id = ?", [id]);
                db.addEvent(id, "auto_retried", `Auto-retry ${newCount}/${effectiveMax}`);
                queue.push(id);
                stats.autoRetried++;
                ui.info(`Auto-retry ${newCount}/${effectiveMax}: ${id} (${task.title})`);
              } else {
                if (effectiveMax > 0) {
                  db.addEvent(id, "retry_exhausted", `Retry exhausted (${task.retry_count}/${effectiveMax})`);
                }
                stats.totalFailed++;
              }
```

**Step 3: Add auto-retried to drain summary**

In `src/commands/drain.ts`, after the auto-enqueued line in the final summary (after line 275), add:

```typescript
    if (stats.autoRetried > 0) {
      console.log(`  ${ui.dim("Auto-retried:")}  ${stats.autoRetried}`);
    }
```

**Step 4: Add retry info to --dry-run display**

In `src/commands/drain.ts`, around line 110, replace:

```typescript
        console.log(`  ${ui.statusBadge(t.status)} ${ui.bold(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)}${costStr}`);
```

With:

```typescript
        const retryMax = t.max_retries ?? settingsGet("max_retries") ?? 2;
        const retryStr = retryMax > 0 ? ui.dim(` [retries: ${t.retry_count ?? 0}/${retryMax}]`) : ui.dim(" [no-retry]");
        console.log(`  ${ui.statusBadge(t.status)} ${ui.bold(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)}${costStr}${retryStr}`);
```

**Step 5: Run drain retry tests**

Run: `/Users/peter/.bun/bin/bun test tests/commands/drain-retry.test.ts`
Expected: All tests pass.

**Step 6: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/commands/drain.ts
git commit -m "feat: add automatic retry logic to drain poll loop"
```

---

### Task 4: Add `--max-retries` flag to `grove add`

**Files:**
- Modify: `src/commands/add.ts:19` (add variable)
- Modify: `src/commands/add.ts:22-44` (add arg parsing)
- Modify: `src/commands/add.ts:118-121` (add to INSERT)
- Modify: `src/commands/add.ts:147-164` (add to help)

**Step 1: Add maxRetries variable**

In `src/commands/add.ts`, after `let depends = "";` (line 19), add:

```typescript
    let maxRetries: number | null = null;
```

**Step 2: Add arg parsing**

In the `while` loop, after the `--depends` case that ends with `i++;` (around line 35), add before the `-h`/`--help` case:

```typescript
      } else if (arg === "--max-retries" && i + 1 < args.length) {
        const val = parseInt(args[i + 1], 10);
        if (isNaN(val) || val < 0) ui.die("--max-retries requires a non-negative integer");
        maxRetries = val;
        i += 2;
        continue;
      } else if (arg.startsWith("--max-retries=")) {
        const val = parseInt(arg.slice("--max-retries=".length), 10);
        if (isNaN(val) || val < 0) ui.die("--max-retries requires a non-negative integer");
        maxRetries = val;
        i++;
        continue;
      } else if (arg === "--no-retry") {
        maxRetries = 0;
        i++;
        continue;
```

**Step 3: Add max_retries to INSERT**

In `src/commands/add.ts`, replace the INSERT (lines 118-122):

```typescript
    db.exec(
      `INSERT INTO tasks (id, repo, source_type, title, description, status, priority, depends_on, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, repo, SourceType.Manual, description, description, "ingested", 50, depends || null, maxRetries],
    );
```

**Step 4: Update help text**

In `src/commands/add.ts`, add after the `--depends` help line (around line 158):

```typescript
      "  --max-retries N    Max auto-retries in drain (default: global setting)",
      "  --no-retry         Disable auto-retry for this task",
```

**Step 5: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/commands/add.ts
git commit -m "feat: add --max-retries and --no-retry flags to grove add"
```

---

### Task 5: Show retry count in batch status and dashboard

**Files:**
- Modify: `src/lib/dispatch.ts:557-575` (renderBatchStatus)
- Modify: `src/commands/dashboard.ts:278-285` (task lines)

**Step 1: Add retry info to renderBatchStatus**

In `src/lib/dispatch.ts`, inside the `renderBatchStatus` function, after the `cost` variable (line 565), add:

```typescript
    const retry = task.retry_count > 0 ? `${ANSI.dim} (retry ${task.retry_count})${ANSI.reset}` : "";
```

Then change the process.stdout.write call (line 572-575) to append `${retry}`:

```typescript
    process.stdout.write(
      ANSI.clearLine +
      `  ${icon} ${ANSI.bold}${id.padEnd(8)}${ANSI.reset} ${repo} ${title} ${label}  ${ANSI.dim}${elapsed}${ANSI.reset}${cost}${retry}\n`
    );
```

**Step 2: Add retry info to dashboard task lines**

In `src/commands/dashboard.ts`, after the `cost` variable (line 280), add:

```typescript
      const retry = t.retry_count > 0 ? `${DIM} (retry ${t.retry_count})${RESET}` : "";
```

Then modify the taskLines.push (line 283-285) to append `${retry}`:

```typescript
      taskLines.push(
        `  ${padV(`${statusIcon(t.status)} ${BOLD}${t.id}${RESET}`, 10)}${(t.repo ?? "-").padEnd(12)}${padV(statusLabel(t.status), 12)}${truncStr(t.title, titleWidth)}${strat}${cost}${retry}`
      );
```

**Step 3: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/lib/dispatch.ts src/commands/dashboard.ts
git commit -m "feat: show retry count in batch status and dashboard"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `/Users/peter/.bun/bin/bun test`
Expected: All tests pass.

**Step 2: Build the binary**

Run: `/Users/peter/.bun/bin/bun build src/index.ts --compile --outfile bin/grove`
Expected: Binary compiles successfully.

**Step 3: Verify add help shows --max-retries**

Run: `bin/grove add -h`
Expected: Shows `--max-retries N` and `--no-retry` in options.

**Step 4: Verify schema migration works on existing DB**

Run: `bin/grove status`
Expected: No errors. The `init` migration adds retry columns to existing DB.

---

## Unresolved Questions

- Should `retry_count` reset when a user manually dispatches a previously-exhausted task? (Recommend: yes)
- Should retried tasks preserve or discard the previous worktree? (Current: reuse if exists)
- Should `grove status TASK_ID` show retry history from events? (Low priority)
