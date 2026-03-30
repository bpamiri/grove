# Integration Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ~100 new tests covering evaluator gates, step engine, cost monitor, and stream parser — bringing total from 121 to ~220+.

**Architecture:** Pure unit tests using Bun's native test runner. Real git repos for evaluator, real SQLite DBs for engine/cost, temp JSONL files for stream parser. Two source files get new exports (no logic changes).

**Tech Stack:** Bun test runner (`bun:test`), `bun:sqlite`, git CLI, temp files via `node:os` / `node:fs`

---

### Task 1: Export evaluator internals for testing

**Files:**
- Modify: `src/agents/evaluator.ts`

- [ ] **Step 1: Add `export` keyword to internal functions**

In `src/agents/evaluator.ts`, add `export` to these existing function declarations (no logic changes):

```typescript
export function capOutput(buf: Buffer): string {
```

```typescript
export function parseBaseRefFromConfig(treeConfig: string | null): string | undefined {
```

```typescript
export function resolveBaseRef(worktreePath: string, configRef?: string): string {
```

```typescript
export function checkCommits(worktreePath: string, baseRef: string): GateResult {
```

```typescript
export function checkTests(worktreePath: string, timeoutSec: number = 60, testCommand?: string): GateResult {
```

```typescript
export function checkLint(worktreePath: string, timeoutSec: number = 30, lintCommand?: string): GateResult {
```

```typescript
export function checkDiffSize(worktreePath: string, min: number = 1, max: number = 5000, baseRef: string = "origin/main"): GateResult {
```

```typescript
export function resolveGateConfig(treeConfig: string | null): GateConfig {
```

```typescript
export function runGates(worktreePath: string, config: GateConfig): GateResult[] {
```

Also export the `GateResult` and `GateConfig` interfaces:

```typescript
export interface GateResult {
```

```typescript
export interface GateConfig {
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test tests/`
Expected: All 121 tests pass. Adding exports doesn't change behavior.

- [ ] **Step 3: Commit**

```bash
git add src/agents/evaluator.ts
git commit -m "refactor: export evaluator internals for testing"
```

---

### Task 2: Export cost monitor internals for testing

**Files:**
- Modify: `src/monitor/cost.ts`

- [ ] **Step 1: Export `checkBudgets` and add `resetPausedState`**

In `src/monitor/cost.ts`, add `export` to `checkBudgets`:

```typescript
export function checkBudgets(db: Database, budgets: BudgetConfig): void {
```

Add a new function after `isSpawningPaused()` (line 39):

```typescript
/** Reset paused state — for test isolation only */
export function resetPausedState(): void {
  spawningPaused = false;
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun test tests/`
Expected: All 121 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/monitor/cost.ts
git commit -m "refactor: export cost monitor internals for testing"
```

---

### Task 3: Create shared test helpers

**Files:**
- Create: `tests/fixtures/helpers.ts`

- [ ] **Step 1: Write `createTestDb` helper**

Create `tests/fixtures/helpers.ts`:

```typescript
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";

/**
 * Create a temp SQLite database initialized with the Grove schema.
 * Returns the db instance and a cleanup function.
 */
export function createTestDb(): { db: Database; cleanup: () => void } {
  const dbPath = join(tmpdir(), `grove-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.initFromString(SCHEMA_SQL);

  const cleanup = () => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
  };

  return { db, cleanup };
}

export interface FixtureRepoOptions {
  /** Create an initial commit with a README (default: true) */
  initialCommit?: boolean;
  /** Extra files to create and commit: { "src/index.ts": "content" } */
  files?: Record<string, string>;
  /** Branch to create and switch to after initial commit */
  branch?: string;
}

/**
 * Create a real git repo in a temp directory.
 * Returns the repo path and a cleanup function.
 */
export function createFixtureRepo(opts: FixtureRepoOptions = {}): { repoPath: string; cleanup: () => void } {
  const { initialCommit = true, files, branch } = opts;
  const repoPath = join(tmpdir(), `grove-test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });

  // Init repo with "main" as default branch
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repoPath, stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: repoPath, stdin: "ignore" });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: repoPath, stdin: "ignore" });

  if (initialCommit) {
    writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Initial commit"], { cwd: repoPath, stdin: "ignore" });
  }

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(repoPath, filePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add fixture files"], { cwd: repoPath, stdin: "ignore" });
  }

  if (branch) {
    Bun.spawnSync(["git", "checkout", "-b", branch], { cwd: repoPath, stdin: "ignore" });
  }

  const cleanup = () => {
    rmSync(repoPath, { recursive: true, force: true });
  };

  return { repoPath, cleanup };
}
```

- [ ] **Step 2: Verify helpers compile**

Run: `bun build tests/fixtures/helpers.ts --no-bundle`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/helpers.ts
git commit -m "test: add shared test helpers (createTestDb, createFixtureRepo)"
```

---

### Task 4: Stream parser tests

**Files:**
- Create: `tests/agents/stream-parser.test.ts`

This task has no external dependencies (no DB, no git repos) so it's a good one to start with for the actual test files.

- [ ] **Step 1: Write isAlive tests**

Create `tests/agents/stream-parser.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  isAlive,
  parseCost,
  lastActivity,
  formatStreamLine,
  parseBrokerEvent,
} from "../../src/agents/stream-parser";

// Temp directory for JSONL fixture files
const TMP_DIR = join(tmpdir(), `grove-stream-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTmpFile(name: string, content: string): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// isAlive
// ---------------------------------------------------------------------------

describe("isAlive", () => {
  test("returns false for null/undefined", () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
  });

  test("returns false for zero or negative PID", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });

  test("returns true for current process PID", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isAlive(999999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3: Add parseCost tests**

Append to `tests/agents/stream-parser.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// parseCost
// ---------------------------------------------------------------------------

describe("parseCost", () => {
  test("returns zeros for non-existent file", () => {
    const result = parseCost("/tmp/does-not-exist-ever.jsonl");
    expect(result).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("returns zeros for empty file", () => {
    const f = writeTmpFile("empty.jsonl", "");
    expect(parseCost(f)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("returns zeros when no result line present", () => {
    const f = writeTmpFile("no-result.jsonl", '{"type":"text","text":"hello"}\n{"type":"tool_use","name":"Read"}\n');
    expect(parseCost(f)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });

  test("extracts cost and tokens from result line", () => {
    const f = writeTmpFile("with-result.jsonl", [
      '{"type":"text","text":"working..."}',
      '{"type":"result","cost_usd":1.23,"usage":{"input_tokens":5000,"output_tokens":2000}}',
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 1.23, inputTokens: 5000, outputTokens: 2000 });
  });

  test("uses last result line when multiple present", () => {
    const f = writeTmpFile("multi-result.jsonl", [
      '{"type":"result","cost_usd":0.50,"usage":{"input_tokens":1000,"output_tokens":500}}',
      '{"type":"text","text":"resumed"}',
      '{"type":"result","cost_usd":2.00,"usage":{"input_tokens":8000,"output_tokens":3000}}',
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 2.0, inputTokens: 8000, outputTokens: 3000 });
  });

  test("skips garbage lines mixed with valid JSON", () => {
    const f = writeTmpFile("garbage.jsonl", [
      "not json at all",
      '{"type":"result","cost_usd":0.75,"usage":{"input_tokens":3000,"output_tokens":1000}}',
      "another garbage line",
    ].join("\n"));
    expect(parseCost(f)).toEqual({ costUsd: 0.75, inputTokens: 3000, outputTokens: 1000 });
  });
});
```

- [ ] **Step 4: Run to verify**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: 10 tests pass.

- [ ] **Step 5: Add lastActivity tests**

Append to `tests/agents/stream-parser.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// lastActivity
// ---------------------------------------------------------------------------

describe("lastActivity", () => {
  test("returns 'no log' for non-existent file", () => {
    expect(lastActivity("/tmp/nope-never.jsonl")).toBe("no log");
  });

  test("returns 'idle' for empty file", () => {
    const f = writeTmpFile("empty-activity.jsonl", "");
    expect(lastActivity(f)).toBe("idle");
  });

  test("returns 'editing {file}' for edit tool_use", () => {
    const f = writeTmpFile("edit.jsonl", '{"type":"tool_use","tool":"Edit","input":{"file_path":"src/app.ts"}}\n');
    expect(lastActivity(f)).toBe("editing app.ts");
  });

  test("returns 'reading {file}' for read tool_use", () => {
    const f = writeTmpFile("read.jsonl", '{"type":"tool_use","tool":"Read","input":{"file_path":"src/config/db.ts"}}\n');
    expect(lastActivity(f)).toBe("reading db.ts");
  });

  test("returns 'running tests' for bash with test command", () => {
    const f = writeTmpFile("test-cmd.jsonl", '{"type":"tool_use","tool":"Bash","input":{"command":"bun test tests/"}}\n');
    expect(lastActivity(f)).toBe("running tests");
  });

  test("returns 'running git command' for bash with git", () => {
    const f = writeTmpFile("git-cmd.jsonl", '{"type":"tool_use","tool":"Bash","input":{"command":"git status"}}\n');
    expect(lastActivity(f)).toBe("running git command");
  });

  test("returns 'searching codebase' for grep/glob tool", () => {
    const f = writeTmpFile("grep.jsonl", '{"type":"tool_use","tool":"Grep","input":{"pattern":"TODO"}}\n');
    expect(lastActivity(f)).toBe("searching codebase");
  });

  test("returns 'completed' for result type", () => {
    const f = writeTmpFile("done.jsonl", [
      '{"type":"tool_use","tool":"Edit","input":{"file_path":"x.ts"}}',
      '{"type":"result","cost_usd":0.50}',
    ].join("\n"));
    expect(lastActivity(f)).toBe("completed");
  });
});
```

- [ ] **Step 6: Run to verify**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: 18 tests pass.

- [ ] **Step 7: Add formatStreamLine tests**

Append to `tests/agents/stream-parser.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// formatStreamLine
// ---------------------------------------------------------------------------

describe("formatStreamLine", () => {
  test("returns null for empty/whitespace", () => {
    expect(formatStreamLine("")).toBeNull();
    expect(formatStreamLine("   ")).toBeNull();
  });

  test("returns text type for non-JSON string", () => {
    const result = formatStreamLine("plain text output");
    expect(result).toEqual({ type: "text", text: "plain text output" });
  });

  test("returns text type for assistant message", () => {
    const result = formatStreamLine('{"type":"assistant","text":"I will fix the bug"}');
    expect(result).toEqual({ type: "text", text: "I will fix the bug" });
  });

  test("returns tool_use with name and detail", () => {
    const result = formatStreamLine('{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.ts"}}');
    expect(result!.type).toBe("tool_use");
    expect(result!.text).toContain("[Edit]");
    expect(result!.text).toContain("src/app.ts");
  });

  test("returns result with formatted cost", () => {
    const result = formatStreamLine('{"type":"result","cost_usd":1.5}');
    expect(result).toEqual({ type: "result", text: "Session complete. Cost: $1.50" });
  });

  test("returns error with message", () => {
    const result = formatStreamLine('{"type":"error","message":"Rate limited"}');
    expect(result).toEqual({ type: "error", text: "[error] Rate limited" });
  });
});
```

- [ ] **Step 8: Run to verify**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: 24 tests pass.

- [ ] **Step 9: Add parseBrokerEvent tests**

Append to `tests/agents/stream-parser.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// parseBrokerEvent
// ---------------------------------------------------------------------------

describe("parseBrokerEvent", () => {
  test("returns null for empty string", () => {
    expect(parseBrokerEvent("")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseBrokerEvent("not json {")).toBeNull();
  });

  test("returns event for valid JSON with type field", () => {
    const event = parseBrokerEvent('{"type":"status","task":"W-001","msg":"running"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("status");
  });
});
```

- [ ] **Step 10: Run full stream parser suite**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: 27 tests pass.

- [ ] **Step 11: Commit**

```bash
git add tests/agents/stream-parser.test.ts
git commit -m "test: add stream parser tests (27 tests)"
```

---

### Task 5: Cost monitor tests

**Files:**
- Create: `tests/monitor/cost.test.ts`

- [ ] **Step 1: Write checkTaskBudget tests**

Create `tests/monitor/cost.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { checkTaskBudget, checkBudgets, isSpawningPaused, resetPausedState, stopCostMonitor, startCostMonitor } from "../../src/monitor/cost";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";
import type { BudgetConfig } from "../../src/shared/types";

let db: Database;
let cleanup: () => void;

const BUDGETS: BudgetConfig = {
  per_task: 5.0,
  per_session: 10.0,
  per_day: 25.0,
  per_week: 100.0,
  auto_approve_under: 2.0,
};

beforeEach(() => {
  const result = createTestDb();
  db = result.db;
  cleanup = result.cleanup;
  resetPausedState();

  // Seed a tree and task for checkTaskBudget tests
  db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  db.run("INSERT INTO tasks (id, title, tree_id, status) VALUES (?, ?, ?, ?)", ["W-001", "Test task", "t1", "active"]);
});

afterEach(() => {
  stopCostMonitor();
  bus.removeAll("cost:budget_warning");
  bus.removeAll("cost:budget_exceeded");
  cleanup();
});

// ---------------------------------------------------------------------------
// checkTaskBudget
// ---------------------------------------------------------------------------

describe("checkTaskBudget", () => {
  test("returns ok when task cost is under budget", () => {
    db.run("UPDATE tasks SET cost_usd = 3.0 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(3.0);
    expect(result.limit).toBe(5.0);
  });

  test("returns not ok when task cost equals budget (strict <)", () => {
    db.run("UPDATE tasks SET cost_usd = 5.0 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(false);
  });

  test("returns not ok when task cost exceeds budget", () => {
    db.run("UPDATE tasks SET cost_usd = 7.5 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(false);
    expect(result.current).toBe(7.5);
  });

  test("returns ok with zero cost for new task", () => {
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `bun test tests/monitor/cost.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3: Add checkBudgets tests**

Append to `tests/monitor/cost.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// checkBudgets
// ---------------------------------------------------------------------------

describe("checkBudgets", () => {
  // Helper: seed session costs for today
  function seedTodayCost(amount: number) {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.sessionCreate(id, null, "worker");
    db.sessionUpdateCost(id, amount, Math.floor(amount * 1000));
  }

  test("emits no events when daily spend is under 80%", () => {
    seedTodayCost(10.0); // 40% of 25
    const warnings: any[] = [];
    const exceeded: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    expect(warnings.length).toBe(0);
    expect(exceeded.length).toBe(0);
    expect(isSpawningPaused()).toBe(false);
  });

  test("emits budget_warning when daily spend reaches 80%", () => {
    seedTodayCost(20.0); // 80% of 25
    const warnings: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));

    checkBudgets(db, BUDGETS);

    expect(warnings.length).toBe(1);
    expect(warnings[0].period).toBe("daily");
  });

  test("emits budget_exceeded and pauses when daily spend reaches 100%", () => {
    seedTodayCost(25.0); // 100% of 25
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    expect(exceeded.length).toBe(1);
    expect(exceeded[0].period).toBe("daily");
    expect(isSpawningPaused()).toBe(true);
  });

  test("emits budget_warning when weekly spend reaches 80%", () => {
    seedTodayCost(80.0); // 80% of 100 (also over daily, but we check weekly event)
    const warnings: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));

    // Need to reset so daily exceeded doesn't mask weekly warning
    // Actually both daily exceeded AND weekly warning fire — we just check weekly is present
    checkBudgets(db, { ...BUDGETS, per_day: 200 }); // raise daily so only weekly triggers

    expect(warnings.some((w) => w.period === "weekly")).toBe(true);
  });

  test("emits budget_exceeded when weekly spend reaches 100%", () => {
    seedTodayCost(100.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, { ...BUDGETS, per_day: 200 }); // raise daily limit

    expect(exceeded.some((e) => e.period === "weekly")).toBe(true);
    expect(isSpawningPaused()).toBe(true);
  });

  test("pauses only once when both daily and weekly exceeded", () => {
    seedTodayCost(100.0); // over both limits
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    // Should get daily exceeded (pauses) but not weekly (already paused)
    expect(exceeded.length).toBe(1);
    expect(isSpawningPaused()).toBe(true);
  });

  test("unpauses when spend drops back under both limits", () => {
    // First, trigger pause
    seedTodayCost(25.0);
    checkBudgets(db, BUDGETS);
    expect(isSpawningPaused()).toBe(true);

    // Now check with very high limits (simulating spend being "under")
    checkBudgets(db, { ...BUDGETS, per_day: 1000, per_week: 5000 });
    expect(isSpawningPaused()).toBe(false);
  });

  test("does not emit duplicate budget_exceeded when already paused", () => {
    seedTodayCost(30.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS); // first call — pauses, emits
    checkBudgets(db, BUDGETS); // second call — already paused, no emit

    expect(exceeded.length).toBe(1);
  });
});
```

- [ ] **Step 4: Run to verify**

Run: `bun test tests/monitor/cost.test.ts`
Expected: 12 tests pass.

- [ ] **Step 5: Add startCostMonitor/stopCostMonitor tests**

Append to `tests/monitor/cost.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// startCostMonitor / stopCostMonitor
// ---------------------------------------------------------------------------

describe("startCostMonitor / stopCostMonitor", () => {
  test("is idempotent — calling start twice does not error", () => {
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    stopCostMonitor();
    // No error = pass
    expect(true).toBe(true);
  });

  test("runs an immediate check on start", () => {
    seedTodayCostForMonitor(25.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });

    // The immediate check should have fired
    expect(exceeded.length).toBe(1);
    stopCostMonitor();
  });

  test("stop clears interval without error", () => {
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    stopCostMonitor();
    stopCostMonitor(); // double stop is safe
    expect(true).toBe(true);
  });
});

// Helper scoped for monitor tests (needs unique session IDs)
function seedTodayCostForMonitor(amount: number) {
  const id = `s-mon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.sessionCreate(id, null, "worker");
  db.sessionUpdateCost(id, amount, Math.floor(amount * 1000));
}
```

- [ ] **Step 6: Run full cost monitor suite**

Run: `bun test tests/monitor/cost.test.ts`
Expected: 15 tests pass.

- [ ] **Step 7: Commit**

```bash
git add tests/monitor/cost.test.ts
git commit -m "test: add cost monitor tests (15 tests)"
```

---

### Task 6: Evaluator gates tests

**Files:**
- Create: `tests/agents/evaluator-gates.test.ts`

- [ ] **Step 1: Write capOutput and config parsing tests**

Create `tests/agents/evaluator-gates.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, createFixtureRepo } from "../fixtures/helpers";
import {
  capOutput,
  parseBaseRefFromConfig,
  resolveBaseRef,
  resolveGateConfig,
  checkCommits,
  checkTests,
  checkLint,
  checkDiffSize,
  runGates,
  evaluate,
  buildRetryPrompt,
} from "../../src/agents/evaluator";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";
import type { Task, Tree } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// capOutput
// ---------------------------------------------------------------------------

describe("capOutput", () => {
  test("returns string as-is when under 5KB limit", () => {
    const buf = Buffer.from("short output");
    expect(capOutput(buf)).toBe("short output");
  });

  test("returns string as-is when exactly at limit", () => {
    const str = "x".repeat(5000);
    const buf = Buffer.from(str);
    expect(capOutput(buf)).toBe(str);
  });

  test("truncates with suffix when over limit", () => {
    const str = "x".repeat(5001);
    const buf = Buffer.from(str);
    const result = capOutput(buf);
    expect(result.length).toBeLessThan(str.length);
    expect(result).toContain("[... truncated]");
    expect(result.startsWith("x".repeat(5000))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseBaseRefFromConfig
// ---------------------------------------------------------------------------

describe("parseBaseRefFromConfig", () => {
  test("returns undefined for null config", () => {
    expect(parseBaseRefFromConfig(null)).toBeUndefined();
  });

  test("returns base_ref from quality_gates", () => {
    const config = JSON.stringify({ quality_gates: { base_ref: "origin/develop" } });
    expect(parseBaseRefFromConfig(config)).toBe("origin/develop");
  });

  test("returns origin/{branch} from default_branch", () => {
    const config = JSON.stringify({ default_branch: "develop" });
    expect(parseBaseRefFromConfig(config)).toBe("origin/develop");
  });

  test("returns undefined for invalid JSON", () => {
    expect(parseBaseRefFromConfig("not json {{{")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveGateConfig
// ---------------------------------------------------------------------------

describe("resolveGateConfig", () => {
  test("returns defaults for null config", () => {
    const config = resolveGateConfig(null);
    expect(config.commits).toBe(true);
    expect(config.tests).toBe(true);
    expect(config.lint).toBe(false);
    expect(config.diff_size).toBe(true);
  });

  test("merges partial overrides with defaults", () => {
    const config = resolveGateConfig(JSON.stringify({ lint: true, test_timeout: 120 }));
    expect(config.lint).toBe(true);
    expect(config.test_timeout).toBe(120);
    expect(config.commits).toBe(true); // from defaults
  });

  test("extracts from quality_gates nested key", () => {
    const config = resolveGateConfig(JSON.stringify({
      quality_gates: { lint: true, base_ref: "origin/develop" },
      default_branch: "develop",
    }));
    expect(config.lint).toBe(true);
    expect(config.base_ref).toBe("origin/develop");
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 10 tests pass.

- [ ] **Step 3: Add resolveBaseRef and checkCommits tests (need git repo)**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// resolveBaseRef (requires git repo)
// ---------------------------------------------------------------------------

describe("resolveBaseRef", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("returns config ref when provided", () => {
    expect(resolveBaseRef(repoPath, "origin/develop")).toBe("origin/develop");
  });

  test("detects main branch when it exists", () => {
    // Our fixture repo uses "main" as default branch
    const ref = resolveBaseRef(repoPath);
    expect(ref).toBe("main");
  });

  test("falls back to origin/main when no recognized branch exists", () => {
    // Create a repo with a non-standard branch name
    const weird = createFixtureRepo();
    Bun.spawnSync(["git", "checkout", "-b", "trunk"], { cwd: weird.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "branch", "-D", "main"], { cwd: weird.repoPath, stdin: "ignore" });
    const ref = resolveBaseRef(weird.repoPath);
    expect(ref).toBe("origin/main"); // fallback
    weird.cleanup();
  });
});

// ---------------------------------------------------------------------------
// checkCommits (requires git repo with branch)
// ---------------------------------------------------------------------------

describe("checkCommits", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo({ branch: "feature/test" });
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("passes when branch has commits ahead of base", () => {
    // Add a commit on the feature branch
    writeFileSync(join(repoPath, "new-file.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add feature"], { cwd: repoPath, stdin: "ignore" });

    const result = checkCommits(repoPath, "main");
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("hard");
    expect(result.message).toContain("commit");
  });

  test("fails when branch has no commits ahead of base", () => {
    // Create a fresh repo where the branch is at the same point as main
    const fresh = createFixtureRepo({ branch: "empty-branch" });
    const result = checkCommits(fresh.repoPath, "main");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("hard");
    expect(result.message).toBe("No commits found");
    fresh.cleanup();
  });
});
```

- [ ] **Step 4: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 15 tests pass.

- [ ] **Step 5: Add checkDiffSize tests**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// checkDiffSize (requires git repo with changes)
// ---------------------------------------------------------------------------

describe("checkDiffSize", () => {
  test("fails when diff is below minimum", () => {
    // Repo with no changes on branch — zero diff
    const repo = createFixtureRepo({ branch: "no-changes" });
    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("below min");
    repo.cleanup();
  });

  test("passes when diff is within range", () => {
    const repo = createFixtureRepo({ branch: "some-changes" });
    // Add ~10 lines
    writeFileSync(join(repo.repoPath, "feature.ts"), Array(10).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add feature"], { cwd: repo.repoPath, stdin: "ignore" });

    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("lines changed");
    repo.cleanup();
  });

  test("fails when diff exceeds maximum", () => {
    const repo = createFixtureRepo({ branch: "big-changes" });
    // Add way more lines than max
    writeFileSync(join(repo.repoPath, "big.ts"), Array(100).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "Add big file"], { cwd: repo.repoPath, stdin: "ignore" });

    const result = checkDiffSize(repo.repoPath, 1, 10, "main"); // max=10
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("exceeds max");
    repo.cleanup();
  });

  test("zero diff fails min check", () => {
    const repo = createFixtureRepo({ branch: "zero-diff" });
    const result = checkDiffSize(repo.repoPath, 1, 5000, "main");
    expect(result.passed).toBe(false);
    repo.cleanup();
  });
});
```

- [ ] **Step 6: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 19 tests pass.

- [ ] **Step 7: Add checkTests and checkLint tests**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// checkTests
// ---------------------------------------------------------------------------

describe("checkTests", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("skips when no test command configured", () => {
    const result = checkTests(repoPath, 60, undefined);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("skipped");
  });

  test("passes when test command succeeds", () => {
    const result = checkTests(repoPath, 60, "true");
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Tests passed");
  });

  test("fails when test command fails", () => {
    const result = checkTests(repoPath, 60, "echo 'FAIL: assertion error' >&2 && false");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Tests failed");
    expect(result.output).toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// checkLint
// ---------------------------------------------------------------------------

describe("checkLint", () => {
  let repoPath: string;
  let repoCleanup: () => void;

  beforeAll(() => {
    const repo = createFixtureRepo();
    repoPath = repo.repoPath;
    repoCleanup = repo.cleanup;
  });

  afterAll(() => {
    repoCleanup();
  });

  test("skips when no lint command configured", () => {
    const result = checkLint(repoPath, 30, undefined);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("soft");
    expect(result.message).toContain("skipped");
  });

  test("passes when lint command succeeds", () => {
    const result = checkLint(repoPath, 30, "true");
    expect(result.passed).toBe(true);
  });

  test("fails when lint command fails", () => {
    const result = checkLint(repoPath, 30, "echo 'lint error: no-unused-vars' >&2 && false");
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("soft");
    expect(result.output).toContain("lint error");
  });
});
```

- [ ] **Step 8: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 25 tests pass.

- [ ] **Step 9: Add runGates tests**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// runGates
// ---------------------------------------------------------------------------

describe("runGates", () => {
  test("runs all enabled gates", () => {
    const repo = createFixtureRepo({ branch: "all-gates" });
    writeFileSync(join(repo.repoPath, "x.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat"], { cwd: repo.repoPath, stdin: "ignore" });

    const results = runGates(repo.repoPath, {
      commits: true, tests: true, lint: false, diff_size: true,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });

    expect(results.length).toBe(3); // commits, tests (skipped — no cmd), diff_size
    expect(results.map(r => r.gate)).toEqual(["commits", "tests", "diff_size"]);
    repo.cleanup();
  });

  test("skips disabled gates", () => {
    const repo = createFixtureRepo();
    const results = runGates(repo.repoPath, {
      commits: false, tests: false, lint: false, diff_size: false,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });
    expect(results.length).toBe(0);
    repo.cleanup();
  });

  test("includes both hard and soft failures in results", () => {
    // Repo with no commits (hard fail) and no diff (soft fail)
    const repo = createFixtureRepo({ branch: "empty-branch" });
    const results = runGates(repo.repoPath, {
      commits: true, tests: false, lint: false, diff_size: true,
      test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
    });
    const commitResult = results.find(r => r.gate === "commits");
    const diffResult = results.find(r => r.gate === "diff_size");
    expect(commitResult!.passed).toBe(false);
    expect(commitResult!.tier).toBe("hard");
    expect(diffResult!.passed).toBe(false);
    expect(diffResult!.tier).toBe("soft");
    repo.cleanup();
  });
});
```

- [ ] **Step 10: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 28 tests pass.

- [ ] **Step 11: Add evaluate() integration tests**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// evaluate (integration — needs DB + git repo)
// ---------------------------------------------------------------------------

describe("evaluate", () => {
  let db: Database;
  let dbCleanup: () => void;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    dbCleanup = result.cleanup;
    db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  });

  afterEach(() => {
    bus.removeAll("eval:started");
    bus.removeAll("eval:passed");
    bus.removeAll("eval:failed");
    bus.removeAll("gate:result");
    dbCleanup();
  });

  test("returns failure when worktree path does not exist", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "/tmp/does-not-exist-ever"],
    );
    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Worktree not found");
    expect(result.gateResults).toEqual([]);
  });

  test("returns passed when all gates pass", () => {
    const repo = createFixtureRepo({ branch: "work" });
    writeFileSync(join(repo.repoPath, "feature.ts"), "export const a = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat: add feature"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    // Config with no test command so tests gate is skipped
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All gates passed");
    repo.cleanup();
  });

  test("returns failure when hard gate fails", () => {
    // Empty branch — commits gate will fail (hard)
    const repo = createFixtureRepo({ branch: "empty" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(false);
    expect(result.gateResults.some(g => g.gate === "commits" && !g.passed)).toBe(true);
    repo.cleanup();
  });

  test("passes when only soft gates fail", () => {
    const repo = createFixtureRepo({ branch: "soft-fail" });
    // Big file to exceed diff max — but commits pass (hard gate ok)
    writeFileSync(join(repo.repoPath, "big.ts"), Array(200).fill("export const x = 1;").join("\n") + "\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat: big change"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: JSON.stringify({ max_diff_lines: 10 }) });
    const tree = db.treeGet("t1")!;

    const result = evaluate(task, tree, db);
    expect(result.passed).toBe(true); // soft failures don't block
    expect(result.gateResults.some(g => g.gate === "diff_size" && !g.passed)).toBe(true);
    repo.cleanup();
  });

  test("stores gate results on task row", () => {
    const repo = createFixtureRepo({ branch: "store-test" });
    writeFileSync(join(repo.repoPath, "f.ts"), "export const a = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo.repoPath, stdin: "ignore" });
    Bun.spawnSync(["git", "commit", "-m", "feat"], { cwd: repo.repoPath, stdin: "ignore" });

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, worktree_path) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", repo.repoPath],
    );
    const task = db.taskGet("W-001")!;
    db.treeUpsert({ id: "t1", name: "Test", path: repo.repoPath, config: "{}" });
    const tree = db.treeGet("t1")!;

    evaluate(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.gate_results).not.toBeNull();
    const stored = JSON.parse(updated.gate_results!);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBeGreaterThan(0);
    repo.cleanup();
  });
});
```

- [ ] **Step 12: Run to verify**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: 33 tests pass.

- [ ] **Step 13: Add buildRetryPrompt tests**

Append to `tests/agents/evaluator-gates.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------

describe("buildRetryPrompt", () => {
  test("returns empty string when no failures", () => {
    expect(buildRetryPrompt([])).toBe("");
    expect(buildRetryPrompt([
      { gate: "commits", passed: true, tier: "hard", message: "1 commit" },
    ])).toBe("");
  });

  test("includes gate names and messages for failures", () => {
    const prompt = buildRetryPrompt([
      { gate: "commits", passed: false, tier: "hard", message: "No commits found" },
      { gate: "tests", passed: false, tier: "hard", message: "Tests failed (exit 1)", output: "FAIL: auth.test.ts" },
    ]);
    expect(prompt).toContain("commits: FAILED");
    expect(prompt).toContain("No commits found");
    expect(prompt).toContain("tests: FAILED");
    expect(prompt).toContain("FAIL: auth.test.ts");
    expect(prompt).toContain("Fix these issues");
  });

  test("appends seed spec when provided", () => {
    const prompt = buildRetryPrompt(
      [{ gate: "tests", passed: false, tier: "hard", message: "Tests failed (exit 1)" }],
      "Build a REST API with CRUD endpoints",
    );
    expect(prompt).toContain("Seed (Design Spec)");
    expect(prompt).toContain("Build a REST API with CRUD endpoints");
  });
});
```

- [ ] **Step 14: Run full evaluator suite**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: ~36 tests pass.

- [ ] **Step 15: Commit**

```bash
git add tests/agents/evaluator-gates.test.ts
git commit -m "test: add evaluator gate tests (~36 tests)"
```

---

### Task 7: Step engine tests

**Files:**
- Create: `tests/engine/step-engine.test.ts`

- [ ] **Step 1: Write normalizePath tests**

Create `tests/engine/step-engine.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { normalizePath, normalizeAllPaths, stripPrompts } from "../../src/engine/normalize";
import { createTestDb } from "../fixtures/helpers";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";
import type { PathConfig } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// normalizePath / normalizeAllPaths / stripPrompts
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  test("string step 'implement' becomes worker type", () => {
    const result = normalizePath({ description: "test", steps: ["implement"] });
    expect(result.steps[0].id).toBe("implement");
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[0].on_success).toBe("$done"); // only step → $done
    expect(result.steps[0].on_failure).toBe("$fail");
  });

  test("string step 'merge' infers merge type", () => {
    const result = normalizePath({ description: "test", steps: ["merge"] });
    expect(result.steps[0].type).toBe("merge");
  });

  test("string step 'evaluate' infers gate type", () => {
    const result = normalizePath({ description: "test", steps: ["evaluate"] });
    expect(result.steps[0].type).toBe("gate");
  });

  test("object step with id key uses explicit props", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "custom", type: "worker", on_success: "$done", on_failure: "$fail", prompt: "Do stuff" }],
    });
    expect(result.steps[0].id).toBe("custom");
    expect(result.steps[0].type).toBe("worker");
    expect(result.steps[0].prompt).toBe("Do stuff");
  });

  test("object shorthand extracts id from key", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ plan: { prompt: "Plan the work" } }],
    });
    expect(result.steps[0].id).toBe("plan");
    expect(result.steps[0].prompt).toBe("Plan the work");
  });

  test("auto-wires on_success for intermediate steps to next step", () => {
    const result = normalizePath({
      description: "test",
      steps: ["plan", "implement", "evaluate"],
    });
    expect(result.steps[0].on_success).toBe("implement");
    expect(result.steps[1].on_success).toBe("evaluate");
    expect(result.steps[2].on_success).toBe("$done");
  });

  test("on_failure defaults to $fail", () => {
    const result = normalizePath({ description: "test", steps: ["plan", "implement"] });
    expect(result.steps[0].on_failure).toBe("$fail");
    expect(result.steps[1].on_failure).toBe("$fail");
  });

  test("auto-capitalizes label", () => {
    const result = normalizePath({ description: "test", steps: ["implement"] });
    expect(result.steps[0].label).toBe("Implement");
  });

  test("multi-step path wires full chain correctly", () => {
    const result = normalizePath({
      description: "dev",
      steps: [
        { plan: { type: "worker", prompt: "Plan" } },
        { implement: { type: "worker", prompt: "Build" } },
        { evaluate: { on_failure: "implement" } },
        "merge",
      ],
    });
    expect(result.steps.length).toBe(4);
    expect(result.steps[0].on_success).toBe("implement");
    expect(result.steps[1].on_success).toBe("evaluate");
    expect(result.steps[2].on_success).toBe("merge");
    expect(result.steps[2].on_failure).toBe("implement");
    expect(result.steps[3].on_success).toBe("$done");
  });
});

describe("stripPrompts", () => {
  test("removes prompt fields from all steps", () => {
    const paths = normalizeAllPaths({
      dev: {
        description: "dev",
        steps: [{ plan: { prompt: "secret prompt" } }, "implement"],
      },
    });
    const stripped = stripPrompts(paths);
    expect(stripped.dev.steps[0].prompt).toBeUndefined();
    expect(stripped.dev.steps[0].id).toBe("plan");
    expect(stripped.dev.steps[1].id).toBe("implement");
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `bun test tests/engine/step-engine.test.ts`
Expected: 10 tests pass.

- [ ] **Step 3: Add startPipeline tests**

Append to `tests/engine/step-engine.test.ts`. These need to mock `configNormalizedPaths` and the dynamic imports:

```typescript
// ---------------------------------------------------------------------------
// startPipeline / onStepComplete (requires DB + mocks)
// ---------------------------------------------------------------------------

// We need to mock configNormalizedPaths and the dynamic imports to avoid
// spawning real workers/evaluators. We'll use Bun's mock.module.

// Track calls to executeStep's dynamic imports
let spawnWorkerCalls: any[] = [];
let evaluateCalls: any[] = [];
let queueMergeCalls: any[] = [];

// Mock the worker/evaluator/merge modules
mock.module("../../src/agents/worker", () => ({
  spawnWorker: (...args: any[]) => { spawnWorkerCalls.push(args); },
}));

mock.module("../../src/agents/evaluator", () => ({
  evaluate: (...args: any[]) => {
    evaluateCalls.push(args);
    return { passed: true, gateResults: [], feedback: "All gates passed", costUsd: 0 };
  },
}));

mock.module("../../src/merge/manager", () => ({
  queueMerge: (...args: any[]) => { queueMergeCalls.push(args); },
}));

// We need to provide a known path config for tests.
// Import step-engine AFTER mocks are set up.
const TEST_PATHS = {
  development: {
    description: "Standard dev workflow",
    steps: [
      { id: "plan", type: "worker" as const, on_success: "implement", on_failure: "$fail", label: "Plan" },
      { id: "implement", type: "worker" as const, on_success: "evaluate", on_failure: "$fail", label: "Implement" },
      { id: "evaluate", type: "gate" as const, on_success: "merge", on_failure: "implement", label: "Evaluate", max_retries: 2 },
      { id: "merge", type: "merge" as const, on_success: "$done", on_failure: "$fail", label: "Merge" },
    ],
  },
};

// Mock configNormalizedPaths to return our test paths
mock.module("../../src/broker/config", () => ({
  configNormalizedPaths: () => TEST_PATHS,
}));

// Also mock getEnv for executeStep's logDir
mock.module("../../src/broker/db", () => {
  // Re-export the real Database class but mock getEnv
  const actual = require("../../src/broker/db");
  return {
    ...actual,
    getEnv: () => ({
      GROVE_HOME: "/tmp/grove-test",
      GROVE_DB: "/tmp/grove-test/grove.db",
      GROVE_CONFIG: "/tmp/grove-test/grove.yaml",
      GROVE_LOG_DIR: "/tmp/grove-test/logs",
    }),
  };
});

// Now import step-engine (picks up mocked modules)
const { startPipeline, onStepComplete } = await import("../../src/engine/step-engine");

describe("startPipeline", () => {
  let db: Database;
  let dbCleanup: () => void;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    dbCleanup = result.cleanup;
    spawnWorkerCalls = [];
    evaluateCalls = [];
    queueMergeCalls = [];

    db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  });

  afterEach(() => {
    bus.removeAll("task:status");
    bus.removeAll("merge:completed");
    dbCleanup();
  });

  test("sets task to active and enters first step", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "draft", "development"],
    );
    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("active");
    expect(updated.current_step).toBe("plan");
    expect(updated.step_index).toBe(0);
  });

  test("fails task when path config not found", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "draft", "nonexistent-path"],
    );
    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("failed");
  });

  test("skips plan step when task has a seed", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "draft", "development"],
    );
    db.seedCreate("W-001");
    db.seedComplete("W-001", "Summary", "Full spec here");

    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.current_step).toBe("implement"); // skipped "plan"
    expect(updated.step_index).toBe(1);
  });

  test("does not skip when first step is not plan", () => {
    // Use a custom path where first step is "implement"
    const IMPL_FIRST_PATHS = {
      ...TEST_PATHS,
      "impl-first": {
        description: "Impl first",
        steps: [
          { id: "implement", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Implement" },
        ],
      },
    };
    mock.module("../../src/broker/config", () => ({
      configNormalizedPaths: () => IMPL_FIRST_PATHS,
    }));

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "draft", "impl-first"],
    );
    db.seedCreate("W-001");
    db.seedComplete("W-001", "Summary", "Spec");

    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.current_step).toBe("implement"); // no skip — step isn't "plan"
    expect(updated.step_index).toBe(0);

    // Restore original mock
    mock.module("../../src/broker/config", () => ({
      configNormalizedPaths: () => TEST_PATHS,
    }));
  });

  test("does not skip when single-step path with seed", () => {
    const SINGLE_PATHS = {
      ...TEST_PATHS,
      single: {
        description: "One step",
        steps: [
          { id: "plan", type: "worker" as const, on_success: "$done", on_failure: "$fail", label: "Plan" },
        ],
      },
    };
    mock.module("../../src/broker/config", () => ({
      configNormalizedPaths: () => SINGLE_PATHS,
    }));

    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "draft", "single"],
    );
    db.seedCreate("W-001");
    db.seedComplete("W-001", "Summary", "Spec");

    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;

    startPipeline(task, tree, db);

    const updated = db.taskGet("W-001")!;
    expect(updated.current_step).toBe("plan"); // can't skip — only one step
    expect(updated.step_index).toBe(0);

    mock.module("../../src/broker/config", () => ({
      configNormalizedPaths: () => TEST_PATHS,
    }));
  });
});
```

- [ ] **Step 4: Run to verify**

Run: `bun test tests/engine/step-engine.test.ts`
Expected: 15 tests pass.

- [ ] **Step 5: Add onStepComplete tests**

Append to `tests/engine/step-engine.test.ts`:

```typescript
describe("onStepComplete", () => {
  let db: Database;
  let dbCleanup: () => void;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    dbCleanup = result.cleanup;
    spawnWorkerCalls = [];
    evaluateCalls = [];
    queueMergeCalls = [];

    // Restore standard test paths
    mock.module("../../src/broker/config", () => ({
      configNormalizedPaths: () => TEST_PATHS,
    }));

    db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  });

  afterEach(() => {
    bus.removeAll("task:status");
    bus.removeAll("merge:completed");
    dbCleanup();
  });

  test("success → $done completes the task", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step, step_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "merge", 3],
    );

    // "merge" step's on_success = "$done"
    startPipeline.__db_hack = db; // We need to set _db — do it via startPipeline first
    // Actually: just call startPipeline with a task at the right state, then call onStepComplete
    const task = db.taskGet("W-001")!;
    const tree = db.treeGet("t1")!;
    // Set the module-level _db by calling startPipeline on a throwaway task
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    onStepComplete("W-001", "success");

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("completed");
    expect(updated.current_step).toBe("$done");
    expect(updated.completed_at).not.toBeNull();
  });

  test("success → next step-id advances the pipeline", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step, step_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "plan", 0],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    // "plan" on_success = "implement"
    onStepComplete("W-001", "success");

    const updated = db.taskGet("W-001")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
  });

  test("failure → $fail with retries remaining increments retry_count", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step, step_index, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "evaluate", 2, 0, 2],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    // "evaluate" on_failure = "implement" — wait, that's a step-id not $fail.
    // Let's use "plan" step which has on_failure = "$fail"
    db.run("UPDATE tasks SET current_step = 'plan', step_index = 0 WHERE id = 'W-001'");

    onStepComplete("W-001", "failure");

    const updated = db.taskGet("W-001")!;
    expect(updated.retry_count).toBe(1);
    expect(updated.status).toBe("active"); // still active, retrying
  });

  test("failure → $fail with retries exhausted fails the task", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step, step_index, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "plan", 0, 2, 2],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    onStepComplete("W-001", "failure");

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("failed");
    expect(updated.current_step).toBe("$fail");

    // Check retry_exhausted event was logged
    const events = db.eventsByTask("W-001");
    expect(events.some(e => e.event_type === "retry_exhausted")).toBe(true);
  });

  test("failure with step-id target transitions to that step", () => {
    // "evaluate" step has on_failure = "implement"
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step, step_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "evaluate", 2],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    onStepComplete("W-001", "failure");

    const updated = db.taskGet("W-001")!;
    expect(updated.current_step).toBe("implement");
    expect(updated.step_index).toBe(1);
  });

  test("fails task when path config not found during completion", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "nonexistent", "step1"],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    onStepComplete("W-001", "success");

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("failed");
  });

  test("fails task when current step not found in config", () => {
    db.run(
      "INSERT INTO tasks (id, title, tree_id, status, path_name, current_step) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-001", "Test", "t1", "active", "development", "nonexistent-step"],
    );
    const tree = db.treeGet("t1")!;
    db.run("INSERT INTO tasks (id, title, tree_id, status, path_name) VALUES (?, ?, ?, ?, ?)",
      ["W-INIT", "Init", "t1", "draft", "development"]);
    startPipeline(db.taskGet("W-INIT")!, tree, db);

    onStepComplete("W-001", "success");

    const updated = db.taskGet("W-001")!;
    expect(updated.status).toBe("failed");
  });
});
```

- [ ] **Step 6: Run full step engine suite**

Run: `bun test tests/engine/step-engine.test.ts`
Expected: ~22 tests pass.

- [ ] **Step 7: Commit**

```bash
git add tests/engine/step-engine.test.ts
git commit -m "test: add step engine tests (~22 tests)"
```

---

### Task 8: Run full suite and verify counts

- [ ] **Step 1: Run all tests**

Run: `bun test tests/`
Expected: All tests pass, total count is 200+.

- [ ] **Step 2: Check test duration**

Verify output shows total time under 30 seconds.

- [ ] **Step 3: Fix any failures**

If any tests fail, fix them. Common issues:
- Mock module paths may need adjustment (relative vs absolute)
- `Bun.spawnSync` in evaluator tests needs the git repo to have the expected state
- Event bus listeners may leak between tests if `removeAll` is missing

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test: fix test failures from full suite run"
```

---

### Task 9: Final cleanup and PR

- [ ] **Step 1: Run full suite one final time**

Run: `bun test tests/`
Expected: All tests pass, 200+ total.

- [ ] **Step 2: Create feature branch and PR**

```bash
git checkout -b peter/integration-test-suite
git push -u origin peter/integration-test-suite
gh pr create --title "test: integration test suite for evaluator, step engine, cost, stream parser" --body "Closes #39

## Summary
- Added ~100 new tests across 4 test files + shared helpers
- Evaluator gates: real git repos, all gate functions tested
- Step engine: normalization + pipeline transitions with mocked workers
- Cost monitor: budget thresholds, pause/unpause, event emission
- Stream parser: JSONL parsing, activity detection, formatting

## Test plan
- [ ] \`bun test tests/\` — all tests pass
- [ ] Total test count 200+
- [ ] Duration under 30 seconds"
```
