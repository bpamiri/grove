# T3: Integration Test Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end test harness with a mock Claude CLI binary that simulates agent behavior, enabling full task lifecycle tests without real API calls.

**Architecture:** A mock `claude` script (Bun) emits stream-json based on env var behavior mode. A `createTestBroker()` helper spins up an isolated broker with temp DB, config, and git repo. Test suites validate the full pipeline: create → dispatch → worker → evaluate → merge.

**Tech Stack:** Bun, bun:test, temp directories, mock CLI binary

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T3 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `tests/fixtures/mock-claude.ts` | Mock Claude CLI — emits stream-json based on behavior env var |
| Create | `tests/integration/helpers.ts` | Test broker factory, cleanup, assertion helpers |
| Create | `tests/integration/task-lifecycle.test.ts` | End-to-end task lifecycle tests |
| Create | `tests/integration/sap-compliance.test.ts` | SAP event protocol validation |
| Modify | `package.json` | Add `test:integration` script |

---

### Task 1: Mock Claude CLI Binary

**Files:** Create `tests/fixtures/mock-claude.ts`

- [ ] **Step 1: Create mock claude script**

Create `tests/fixtures/mock-claude.ts`:

```typescript
#!/usr/bin/env bun
// Mock Claude CLI for integration tests
// Behavior controlled by MOCK_CLAUDE_BEHAVIOR env var:
//   "success"  — emit assistant message + tool_use + result with cost (default)
//   "fail"     — emit error result with exit code 1
//   "seed"     — emit seed_complete JSON event
//   "slow"     — 2s delay between events
//   "crash"    — exit mid-stream with code 1

const behavior = process.env.MOCK_CLAUDE_BEHAVIOR ?? "success";
const args = process.argv.slice(2);

// Parse -p flag for prompt
const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] ?? "" : "";

// Parse --session-id or --resume for session tracking
const sessionIdx = args.indexOf("--session-id");
const resumeIdx = args.indexOf("--resume");
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : (resumeIdx >= 0 ? args[resumeIdx + 1] : null);

// Store session state in /tmp for --resume support
const sessionDir = "/tmp/mock-claude-sessions";
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
mkdirSync(sessionDir, { recursive: true });

if (sessionId && resumeIdx >= 0 && existsSync(`${sessionDir}/${sessionId}.json`)) {
  const state = JSON.parse(readFileSync(`${sessionDir}/${sessionId}.json`, "utf-8"));
  state.messageCount++;
  writeFileSync(`${sessionDir}/${sessionId}.json`, JSON.stringify(state));
} else if (sessionId) {
  writeFileSync(`${sessionDir}/${sessionId}.json`, JSON.stringify({ sessionId, messageCount: 1 }));
}

function emit(obj: any) {
  console.log(JSON.stringify(obj));
}

async function run() {
  switch (behavior) {
    case "success": {
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll implement this now." },
            { type: "tool_use", name: "Read", input: { file_path: "src/main.ts" } },
          ],
        },
      });
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/main.ts" } },
            { type: "text", text: "Done. Changes committed." },
          ],
        },
      });
      emit({ type: "result", cost_usd: 0.05, usage: { input_tokens: 1000, output_tokens: 500 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "fail": {
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "I encountered an error." }] },
      });
      emit({ type: "result", cost_usd: 0.02, usage: { input_tokens: 500, output_tokens: 100 }, subtype: "error_max_turns" });
      process.exit(1);
      break;
    }

    case "seed": {
      emit({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: 'Let me explore the codebase.\n{"type":"seed_complete","summary":"Auth redesign with JWT","spec":"## Spec\\nUse JWT tokens with refresh."}',
          }],
        },
      });
      emit({ type: "result", cost_usd: 0.03, usage: { input_tokens: 800, output_tokens: 300 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "slow": {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Starting..." }] } });
      await new Promise(r => setTimeout(r, 2000));
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
      emit({ type: "result", cost_usd: 0.10, usage: { input_tokens: 2000, output_tokens: 1000 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "crash": {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Working..." }] } });
      process.exit(1);
      break;
    }

    default:
      emit({ type: "result", cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, subtype: "success" });
      process.exit(0);
  }
}

run();
```

- [ ] **Step 2: Make it executable and test**

```bash
chmod +x tests/fixtures/mock-claude.ts
MOCK_CLAUDE_BEHAVIOR=success bun tests/fixtures/mock-claude.ts -p "test" --output-format stream-json 2>&1 | head -5
```

Expected: JSON lines output with assistant messages and result.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/mock-claude.ts
git commit -m "feat: add mock Claude CLI binary for integration tests"
```

---

### Task 2: Integration Test Helpers

**Files:** Create `tests/integration/helpers.ts`

- [ ] **Step 1: Create test broker factory**

Create `tests/integration/helpers.ts`:

```typescript
// Integration test helpers — create isolated test brokers with mock claude
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import * as yaml from "yaml";

export interface TestBroker {
  db: Database;
  groveHome: string;
  treePath: string;
  configPath: string;
  logDir: string;
  cleanup: () => void;
}

/** Create an isolated test environment with DB, config, and git repo */
export function createTestBroker(opts?: {
  mockBehavior?: string;
  treeName?: string;
}): TestBroker {
  const id = `grove-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const groveHome = join(tmpdir(), id);
  const treePath = join(groveHome, "test-repo");
  const logDir = join(groveHome, "logs");
  const configPath = join(groveHome, "grove.yaml");
  const dbPath = join(groveHome, "grove.db");

  // Create directories
  mkdirSync(groveHome, { recursive: true });
  mkdirSync(treePath, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Initialize git repo
  Bun.spawnSync(["git", "init"], { cwd: treePath });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: treePath });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: treePath });
  writeFileSync(join(treePath, "README.md"), "# Test Repo");
  Bun.spawnSync(["git", "add", "-A"], { cwd: treePath });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: treePath });

  // Write config
  const config = {
    version: 2,
    workspace: { name: "Test" },
    trees: {
      [opts?.treeName ?? "test"]: {
        path: treePath,
        branch_prefix: "grove/",
      },
    },
    paths: {},
    budgets: { per_task: 5, per_session: 10, per_day: 25, per_week: 100, auto_approve_under: 2 },
    server: { port: "auto" },
    tunnel: { provider: "cloudflare", auth: "none" },
    settings: { max_workers: 2, branch_prefix: "grove/", stall_timeout_minutes: 5, max_retries: 2 },
  };
  writeFileSync(configPath, yaml.stringify(config));

  // Initialize DB
  const db = new Database(dbPath);
  db.initFromString(SCHEMA_SQL);

  // Sync tree to DB
  db.treeUpsert({
    id: opts?.treeName ?? "test",
    name: opts?.treeName ?? "test",
    path: treePath,
    github: null,
    branch_prefix: "grove/",
    config: "{}",
  });

  const cleanup = () => {
    db.close();
    rmSync(groveHome, { recursive: true, force: true });
  };

  return { db, groveHome, treePath, configPath, logDir, cleanup };
}

/** Create a task in the test DB and return its ID */
export function createTestTask(db: Database, opts?: {
  treeId?: string;
  title?: string;
  status?: string;
  pathName?: string;
}): string {
  const id = db.nextTaskId("W");
  db.run(
    "INSERT INTO tasks (id, tree_id, title, status, path_name) VALUES (?, ?, ?, ?, ?)",
    [id, opts?.treeId ?? "test", opts?.title ?? "Test task", opts?.status ?? "draft", opts?.pathName ?? "development"],
  );
  return id;
}

/** Path to the mock claude script */
export const MOCK_CLAUDE_PATH = join(import.meta.dir, "../fixtures/mock-claude.ts");
```

- [ ] **Step 2: Commit**

```bash
git add tests/integration/helpers.ts
git commit -m "feat: add integration test helpers with test broker factory"
```

---

### Task 3: Task Lifecycle Integration Tests

**Files:** Create `tests/integration/task-lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle tests**

Create `tests/integration/task-lifecycle.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestBroker, createTestTask, type TestBroker } from "./helpers";

let broker: TestBroker;

beforeEach(() => {
  broker = createTestBroker();
});

afterEach(() => {
  broker.cleanup();
});

describe("task lifecycle", () => {
  test("creates a task in draft status", () => {
    const taskId = createTestTask(broker.db);
    const task = broker.db.taskGet(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("draft");
    expect(task!.tree_id).toBe("test");
  });

  test("task transitions from draft to queued on dispatch", () => {
    const taskId = createTestTask(broker.db);
    broker.db.taskSetStatus(taskId, "queued");
    const task = broker.db.taskGet(taskId);
    expect(task!.status).toBe("queued");
  });

  test("task with depends_on is blocked until dependency completes", () => {
    const depId = createTestTask(broker.db, { title: "Dependency" });
    const taskId = createTestTask(broker.db, { title: "Dependent" });
    broker.db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [depId, taskId]);

    expect(broker.db.isTaskBlocked(taskId)).toBe(true);

    // Complete the dependency
    broker.db.taskSetStatus(depId, "completed");
    expect(broker.db.isTaskBlocked(taskId)).toBe(false);
  });

  test("getNewlyUnblocked returns tasks when dependency completes", () => {
    const depId = createTestTask(broker.db, { title: "Dep", status: "active" });
    const waiterId = createTestTask(broker.db, { title: "Waiter", status: "queued" });
    broker.db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [depId, waiterId]);

    broker.db.taskSetStatus(depId, "completed");
    const unblocked = broker.db.getNewlyUnblocked(depId);
    expect(unblocked.map((t: any) => t.id)).toContain(waiterId);
  });

  test("task cost accumulates across sessions", () => {
    const taskId = createTestTask(broker.db, { status: "active" });
    const sid1 = `worker-${taskId}-1`;
    const sid2 = `worker-${taskId}-2`;

    broker.db.sessionCreate(sid1, taskId, "worker");
    broker.db.sessionUpdateCost(sid1, 0.50, 5000);
    broker.db.sessionEnd(sid1, "completed");
    broker.db.run("UPDATE tasks SET cost_usd = cost_usd + 0.50 WHERE id = ?", [taskId]);

    broker.db.sessionCreate(sid2, taskId, "worker");
    broker.db.sessionUpdateCost(sid2, 0.30, 3000);
    broker.db.sessionEnd(sid2, "completed");
    broker.db.run("UPDATE tasks SET cost_usd = cost_usd + 0.30 WHERE id = ?", [taskId]);

    const task = broker.db.taskGet(taskId);
    expect(task!.cost_usd).toBeCloseTo(0.80, 2);
  });

  test("retry_count increments on failure", () => {
    const taskId = createTestTask(broker.db, { status: "active" });
    broker.db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
    broker.db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
    const task = broker.db.taskGet(taskId);
    expect(task!.retry_count).toBe(2);
  });

  test("task edges work for DAG dependencies", () => {
    const a = createTestTask(broker.db, { title: "A" });
    const b = createTestTask(broker.db, { title: "B" });
    broker.db.addEdge(a, b);

    const edges = broker.db.allTaskEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].from_task).toBe(a);
    expect(edges[0].to_task).toBe(b);
  });

  test("checkpoint saves and loads", () => {
    const taskId = createTestTask(broker.db);
    const checkpoint = JSON.stringify({ taskId, stepId: "implement", commitSha: "abc123" });
    broker.db.checkpointSave(taskId, checkpoint);

    const loaded = broker.db.checkpointLoad(taskId);
    expect(loaded).not.toBeNull();
    const parsed = JSON.parse(loaded!);
    expect(parsed.stepId).toBe("implement");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/integration/task-lifecycle.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/task-lifecycle.test.ts
git commit -m "feat: add task lifecycle integration tests"
```

---

### Task 4: SAP Compliance Tests

**Files:** Create `tests/integration/sap-compliance.test.ts`

- [ ] **Step 1: Write SAP compliance tests**

Create `tests/integration/sap-compliance.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { isSapEvent, parseSapEvent } from "../../src/shared/protocol";
import { ActivityRingBuffer } from "../../src/broker/ring-buffer";
import { BatchedBroadcaster } from "../../src/broker/batched-broadcaster";

describe("SAP event compliance", () => {
  test("agent:spawned event is valid SAP", () => {
    const event = { type: "agent:spawned", agentId: "w-1", role: "worker", taskId: "W-001", pid: 123, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:tool_use event is valid SAP", () => {
    const event = { type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Read", input: "src/a.ts", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:thinking event is valid SAP", () => {
    const event = { type: "agent:thinking", agentId: "w-1", taskId: "W-001", snippet: "Analyzing...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("agent:cost event is valid SAP", () => {
    const event = { type: "agent:cost", agentId: "w-1", taskId: "W-001", costUsd: 0.05, tokens: 1500, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("seed:complete event is valid SAP", () => {
    const event = { type: "seed:complete", taskId: "W-001", summary: "Auth", spec: "## Spec", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("ring buffer stores and retrieves SAP events", () => {
    const buf = new ActivityRingBuffer(50);
    const event = { type: "agent:tool_use", taskId: "W-001", tool: "Edit", input: "a.ts", ts: Date.now() };
    buf.push("W-001", event);
    const events = buf.get("W-001");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent:tool_use");
  });

  test("batched broadcaster queues and flushes SAP events", async () => {
    const sent: string[] = [];
    const b = new BatchedBroadcaster(30, (msg) => sent.push(msg));
    b.queue("agent:tool_use", { taskId: "W-001", tool: "Read", ts: 1 });
    b.queue("agent:thinking", { taskId: "W-001", snippet: "hmm", ts: 2 });
    expect(sent.length).toBe(0);
    await new Promise(r => setTimeout(r, 50));
    expect(sent.length).toBe(2);
    // Verify each is valid JSON with SAP structure
    for (const msg of sent) {
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBeTruthy();
      expect(parsed.ts).toBeTruthy();
    }
    b.stop();
  });

  test("parseSapEvent round-trips correctly", () => {
    const event = { type: "agent:ended", agentId: "w-1", role: "worker", taskId: "W-001", exitCode: 0, ts: 12345 };
    const json = JSON.stringify(event);
    const parsed = parseSapEvent(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("agent:ended");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/integration/sap-compliance.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/sap-compliance.test.ts
git commit -m "feat: add SAP event compliance integration tests"
```

---

### Task 5: Package.json Script + Verification

**Files:** Modify `package.json`

- [ ] **Step 1: Add test:integration script**

In `package.json`, add to the `"scripts"` section:

```json
"test:integration": "bun test tests/integration/"
```

- [ ] **Step 2: Run integration tests**

Run: `bun run test:integration`
Expected: All integration tests PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add test:integration script, complete T3 integration test harness"
```
