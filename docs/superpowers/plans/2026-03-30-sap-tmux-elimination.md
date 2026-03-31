# T1: Structured Agent Protocol (SAP) + Tmux Elimination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a typed JSON event protocol (SAP) for all broker-agent communication, refactor seed sessions from tmux to `--resume` subprocess pattern, delete `tmux.ts`, and standardize all agents on SAP events. Enables Windows support.

**Architecture:** SAP defines typed events (`agent:spawned`, `agent:tool_use`, `seed:response`, etc.) in `src/shared/protocol.ts`. All agents (worker, orchestrator, reviewer, seed) emit SAP events via the existing event bus. Seed sessions use the same `--session-id` + `--resume` pattern already proven in the orchestrator — each user message spawns a new `claude` process that resumes the session. tmux.ts is deleted entirely.

**Tech Stack:** Bun subprocess (`Bun.spawn`), Claude Code CLI (`claude -p --resume --output-format stream-json`), existing event bus + WebSocket broadcast

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T1 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/shared/protocol.ts` | SAP event type definitions |
| Create | `tests/shared/protocol.test.ts` | SAP event parsing + validation tests |
| Rewrite | `src/broker/seed-session.ts` | Replace tmux with --resume subprocess pattern |
| Create | `tests/broker/seed-session.test.ts` | Seed session lifecycle tests |
| Delete | `src/broker/tmux.ts` | Remove entirely |
| Modify | `src/shared/types.ts` | Remove `tmux_pane` from Session, `"tmux"` from BrokerEvent |
| Modify | `src/broker/event-bus.ts` | Add SAP event types to EventBusMap |
| Modify | `src/agents/worker.ts` | Emit SAP events instead of ad-hoc bus.emit |
| Modify | `src/agents/orchestrator.ts` | Emit SAP events for tool_use and cost |
| Modify | `src/agents/reviewer.ts` | Emit SAP events instead of ad-hoc bus.emit |
| Modify | `src/broker/server.ts` | Forward new SAP events over WebSocket, update seed WS handlers |
| Modify | `src/broker/index.ts` | Remove `tmuxSession` from BrokerInfo |
| Modify | `src/cli/commands/down.ts` | Remove tmux kill-session cleanup |

---

### Task 1: SAP Event Protocol Types

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `tests/shared/protocol.test.ts`

- [ ] **Step 1: Write failing tests for SAP event validation**

Create `tests/shared/protocol.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { isSapEvent, parseSapEvent, type SapEvent } from "../../src/shared/protocol";

describe("isSapEvent", () => {
  test("validates agent:spawned event", () => {
    const event = { type: "agent:spawned", agentId: "w-1", role: "worker", taskId: "W-001", pid: 123, ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates agent:tool_use event", () => {
    const event = { type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Read", input: "src/foo.ts", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates seed:response event", () => {
    const event = { type: "seed:response", taskId: "W-001", content: "Here's my analysis...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("validates seed:complete event", () => {
    const event = { type: "seed:complete", taskId: "W-001", summary: "Auth redesign", spec: "## Spec\n...", ts: Date.now() };
    expect(isSapEvent(event)).toBe(true);
  });

  test("rejects event without type", () => {
    expect(isSapEvent({ agentId: "w-1", taskId: "W-001" })).toBe(false);
  });

  test("rejects event without ts", () => {
    expect(isSapEvent({ type: "agent:spawned", agentId: "w-1" })).toBe(false);
  });

  test("rejects unknown event type", () => {
    expect(isSapEvent({ type: "unknown:event", ts: Date.now() })).toBe(false);
  });
});

describe("parseSapEvent", () => {
  test("parses valid JSON string into SapEvent", () => {
    const json = JSON.stringify({ type: "agent:tool_use", agentId: "w-1", taskId: "W-001", tool: "Edit", input: "src/a.ts", ts: 1234 });
    const event = parseSapEvent(json);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("agent:tool_use");
  });

  test("returns null for invalid JSON", () => {
    expect(parseSapEvent("not json")).toBeNull();
  });

  test("returns null for non-SAP object", () => {
    expect(parseSapEvent(JSON.stringify({ foo: "bar" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/shared/protocol.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create SAP protocol types and validators**

Create `src/shared/protocol.ts`:

```typescript
// Grove v3 — Structured Agent Protocol (SAP) event types
// All broker-agent and broker-client (WebSocket) communication uses these typed events.

import type { AgentRole, TaskStatus, Task } from "./types";

// ---------------------------------------------------------------------------
// SAP Event Union
// ---------------------------------------------------------------------------

export type SapEvent =
  // Agent lifecycle
  | SapAgentSpawned
  | SapAgentEnded
  | SapAgentCrashed

  // Fine-grained activity (from stream-json parsing)
  | SapAgentToolUse
  | SapAgentThinking
  | SapAgentText
  | SapAgentCost

  // Seed-specific
  | SapSeedResponse
  | SapSeedComplete
  | SapSeedIdle

  // Task lifecycle
  | SapTaskStatus
  | SapTaskCreated

  // Gate results
  | SapGateResult

  // Merge lifecycle
  | SapMergePrCreated
  | SapMergeCompleted

  // Cost/budget
  | SapCostWarning
  | SapCostExceeded;

// ---------------------------------------------------------------------------
// Individual event types
// ---------------------------------------------------------------------------

interface SapBase { ts: number }

export interface SapAgentSpawned extends SapBase { type: "agent:spawned"; agentId: string; role: string; taskId: string; pid: number }
export interface SapAgentEnded extends SapBase { type: "agent:ended"; agentId: string; role: string; taskId: string; exitCode: number }
export interface SapAgentCrashed extends SapBase { type: "agent:crashed"; agentId: string; role: string; taskId: string; error: string }

export interface SapAgentToolUse extends SapBase { type: "agent:tool_use"; agentId: string; taskId: string; tool: string; input: string }
export interface SapAgentThinking extends SapBase { type: "agent:thinking"; agentId: string; taskId: string; snippet: string }
export interface SapAgentText extends SapBase { type: "agent:text"; agentId: string; taskId: string; content: string }
export interface SapAgentCost extends SapBase { type: "agent:cost"; agentId: string; taskId: string; costUsd: number; tokens: number }

export interface SapSeedResponse extends SapBase { type: "seed:response"; taskId: string; content: string; html?: string }
export interface SapSeedComplete extends SapBase { type: "seed:complete"; taskId: string; summary: string; spec: string }
export interface SapSeedIdle extends SapBase { type: "seed:idle"; taskId: string }

export interface SapTaskStatus extends SapBase { type: "task:status"; taskId: string; status: string }
export interface SapTaskCreated extends SapBase { type: "task:created"; task: Task }

export interface SapGateResult extends SapBase { type: "gate:result"; taskId: string; gate: string; passed: boolean; message: string }

export interface SapMergePrCreated extends SapBase { type: "merge:pr_created"; taskId: string; prNumber: number; prUrl: string }
export interface SapMergeCompleted extends SapBase { type: "merge:completed"; taskId: string; prNumber: number }

export interface SapCostWarning extends SapBase { type: "cost:warning"; current: number; limit: number; period: string }
export interface SapCostExceeded extends SapBase { type: "cost:exceeded"; current: number; limit: number; period: string }

// ---------------------------------------------------------------------------
// Valid event type strings
// ---------------------------------------------------------------------------

const SAP_EVENT_TYPES = new Set([
  "agent:spawned", "agent:ended", "agent:crashed",
  "agent:tool_use", "agent:thinking", "agent:text", "agent:cost",
  "seed:response", "seed:complete", "seed:idle",
  "task:status", "task:created",
  "gate:result",
  "merge:pr_created", "merge:completed",
  "cost:warning", "cost:exceeded",
]);

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** Check if an object is a valid SAP event (has a known type + ts) */
export function isSapEvent(obj: unknown): obj is SapEvent {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o.type === "string" && SAP_EVENT_TYPES.has(o.type) && typeof o.ts === "number";
}

/** Parse a JSON string into a SapEvent, or return null */
export function parseSapEvent(json: string): SapEvent | null {
  try {
    const obj = JSON.parse(json);
    return isSapEvent(obj) ? obj : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/shared/protocol.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts tests/shared/protocol.test.ts
git commit -m "feat: add SAP event protocol types and validators"
```

---

### Task 2: Update EventBusMap with SAP Event Types

**Files:**
- Modify: `src/shared/types.ts:288-336` (EventBusMap)
- Modify: `src/broker/event-bus.ts` (no code change, just verify types)

- [ ] **Step 1: Add SAP event types to EventBusMap**

In `src/shared/types.ts`, add the new SAP event entries to the existing `EventBusMap` interface. Keep all existing entries (they'll be deprecated later, not removed in this task):

```typescript
// Add these entries inside the existing EventBusMap interface, after the existing entries:

  // SAP agent events
  "agent:spawned": { agentId: string; role: string; taskId: string; pid: number; ts: number };
  "agent:ended": { agentId: string; role: string; taskId: string; exitCode: number; ts: number };
  "agent:crashed": { agentId: string; role: string; taskId: string; error: string; ts: number };
  "agent:tool_use": { agentId: string; taskId: string; tool: string; input: string; ts: number };
  "agent:thinking": { agentId: string; taskId: string; snippet: string; ts: number };
  "agent:text": { agentId: string; taskId: string; content: string; ts: number };
  "agent:cost": { agentId: string; taskId: string; costUsd: number; tokens: number; ts: number };

  // SAP seed events
  "seed:response": { taskId: string; content: string; html?: string; ts: number };
  "seed:complete": { taskId: string; summary: string; spec: string; ts: number };
  "seed:idle": { taskId: string; ts: number };
```

- [ ] **Step 2: Remove tmux_pane and "tmux" references from types**

In `src/shared/types.ts`, remove `tmux_pane` from the `Session` interface:

Replace:
```typescript
export interface Session {
  id: string;
  task_id: string | null;
  role: string;
  pid: number | null;
  tmux_pane: string | null;
  cost_usd: number;
```

With:
```typescript
export interface Session {
  id: string;
  task_id: string | null;
  role: string;
  pid: number | null;
  cost_usd: number;
```

In the `BrokerEvent` type, replace `"tmux"` in the `user_msg` variant:

Replace:
```typescript
  | { type: "user_msg"; from: "web" | "cli" | "tmux"; text: string };
```

With:
```typescript
  | { type: "user_msg"; from: "web" | "cli"; text: string };
```

- [ ] **Step 3: Run full test suite to verify nothing breaks**

Run: `bun test`
Expected: All 384+ tests PASS. The `tmux_pane` field is still in the DB schema and returned by SQLite queries, but TypeScript code no longer references it.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add SAP event types to EventBusMap, remove tmux_pane from Session type"
```

---

### Task 3: Wire SAP Events in Worker

**Files:**
- Modify: `src/agents/worker.ts:100-175` (monitorWorker, spawnWorker)
- Modify: `tests/agents/stream-parser.test.ts` (optional — verify existing tests still pass)

- [ ] **Step 1: Update spawnWorker to emit SAP agent:spawned event**

In `src/agents/worker.ts`, after the existing `bus.emit("worker:spawned", ...)` at line 105, add a SAP event:

Replace:
```typescript
  bus.emit("worker:spawned", { taskId: task.id, sessionId, pid });
```

With:
```typescript
  bus.emit("worker:spawned", { taskId: task.id, sessionId, pid });
  bus.emit("agent:spawned", { agentId: sessionId, role: "worker", taskId: task.id, pid, ts: Date.now() });
```

- [ ] **Step 2: Update monitorWorker to emit SAP activity events**

In `src/agents/worker.ts`, in the `monitorWorker` function, replace the existing activity emission block (lines ~143-165). Keep the existing `worker:activity` emit for backward compat, and add SAP events:

Replace the tool_use block:
```typescript
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                const activity = `${tool}: ${String(file).slice(0, 200)}`;
                if (activity !== lastActivity) {
                  lastActivity = activity;
                  bus.emit("worker:activity", { taskId, msg: activity });
                }
              } else if (block.type === "thinking" && block.thinking) {
                const snippet = block.thinking.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `thinking: ${snippet}`, kind: "thinking" });
              } else if (block.type === "text" && block.text && block.text.length > 10) {
                const snippet = block.text.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `${snippet}`, kind: "text" });
              }
```

With:
```typescript
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                const activity = `${tool}: ${String(file).slice(0, 200)}`;
                if (activity !== lastActivity) {
                  lastActivity = activity;
                  bus.emit("worker:activity", { taskId, msg: activity });
                }
                bus.emit("agent:tool_use", { agentId: sessionId, taskId, tool, input: String(file).slice(0, 500), ts: Date.now() });
              } else if (block.type === "thinking" && block.thinking) {
                const snippet = block.thinking.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `thinking: ${snippet}`, kind: "thinking" });
                bus.emit("agent:thinking", { agentId: sessionId, taskId, snippet, ts: Date.now() });
              } else if (block.type === "text" && block.text && block.text.length > 10) {
                const snippet = block.text.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `${snippet}`, kind: "text" });
                bus.emit("agent:text", { agentId: sessionId, taskId, content: snippet, ts: Date.now() });
              }
```

- [ ] **Step 3: Update cost emission to include SAP event**

In `src/agents/worker.ts`, after the existing cost update (line ~170):

Replace:
```typescript
          if (obj.type === "result" && obj.cost_usd != null) {
            db.sessionUpdateCost(sessionId, Number(obj.cost_usd), Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0));
          }
```

With:
```typescript
          if (obj.type === "result" && obj.cost_usd != null) {
            const costUsd = Number(obj.cost_usd);
            const tokens = Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0);
            db.sessionUpdateCost(sessionId, costUsd, tokens);
            bus.emit("agent:cost", { agentId: sessionId, taskId, costUsd, tokens, ts: Date.now() });
          }
```

- [ ] **Step 4: Update worker:ended to also emit agent:ended**

In `src/agents/worker.ts`, in the `monitorWorker` try block, after the existing `bus.emit("worker:ended", ...)`:

Replace:
```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: exitCode === 0 ? "done" : "failed" });
```

With:
```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: exitCode === 0 ? "done" : "failed" });
    bus.emit("agent:ended", { agentId: sessionId, role: "worker", taskId, exitCode: exitCode ?? 1, ts: Date.now() });
```

In the catch block, after the existing crash emit:

Replace:
```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: "crashed" });
```

With:
```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: "crashed" });
    bus.emit("agent:crashed", { agentId: sessionId, role: "worker", taskId, error: String(err), ts: Date.now() });
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/worker.ts
git commit -m "feat: emit SAP events from worker alongside existing events"
```

---

### Task 4: Wire SAP Events in Reviewer

**Files:**
- Modify: `src/agents/reviewer.ts:98-279`

- [ ] **Step 1: Add SAP agent:spawned event in spawnReviewer**

In `src/agents/reviewer.ts`, after line 100 (`bus.emit("review:started", ...)`), add:

```typescript
  bus.emit("agent:spawned", { agentId: sessionId, role: "reviewer", taskId: task.id, pid: proc.pid, ts: Date.now() });
```

This goes after the `proc` is spawned (after line 117), so move it to after `const proc = Bun.spawn(...)`:

After line 119 (`db.addEvent(task.id, sessionId, "worker_spawned", ...)`), add:

```typescript
  bus.emit("agent:spawned", { agentId: sessionId, role: "reviewer", taskId: task.id, pid: proc.pid, ts: Date.now() });
```

- [ ] **Step 2: Add SAP events in monitorReviewer**

In `src/agents/reviewer.ts`, in `monitorReviewer`, replace the tool_use activity emission:

Replace:
```typescript
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                bus.emit("worker:activity", { taskId, msg: `[reviewer] ${tool}: ${String(file).slice(0, 200)}` });
              }
```

With:
```typescript
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                bus.emit("worker:activity", { taskId, msg: `[reviewer] ${tool}: ${String(file).slice(0, 200)}` });
                bus.emit("agent:tool_use", { agentId: sessionId, taskId, tool, input: String(file).slice(0, 500), ts: Date.now() });
              }
```

- [ ] **Step 3: Add SAP agent:ended and agent:crashed events**

In the successful completion path (after `onStepComplete(taskId, "success")`), add:

```typescript
      bus.emit("agent:ended", { agentId: sessionId, role: "reviewer", taskId, exitCode: exitCode ?? 0, ts: Date.now() });
```

In the rejection path (after `bus.emit("review:rejected", ...)`), add:

```typescript
      bus.emit("agent:ended", { agentId: sessionId, role: "reviewer", taskId, exitCode: exitCode ?? 1, ts: Date.now() });
```

In the catch block (after `bus.emit("review:rejected", ...)`), add:

```typescript
    bus.emit("agent:crashed", { agentId: sessionId, role: "reviewer", taskId, error: String(err), ts: Date.now() });
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agents/reviewer.test.ts`
Expected: All reviewer tests PASS

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/reviewer.ts
git commit -m "feat: emit SAP events from reviewer alongside existing events"
```

---

### Task 5: Wire SAP Events in Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts:249-260` (monitorOrchestrator tool_use and cost)

- [ ] **Step 1: Add SAP tool_use event in monitorOrchestrator**

In `src/agents/orchestrator.ts`, in `monitorOrchestrator`, replace the tool_use emission:

Replace:
```typescript
            } else if (block.type === "tool_use") {
              const tool = block.name ?? "tool";
              const input = block.input ?? {};
              const detail = (input.file_path ?? input.command ?? input.pattern ?? "").toString().slice(0, 200);
              bus.emit("worker:activity", { taskId: "orchestrator", msg: `${tool}: ${detail}` });
            }
```

With:
```typescript
            } else if (block.type === "tool_use") {
              const tool = block.name ?? "tool";
              const input = block.input ?? {};
              const detail = (input.file_path ?? input.command ?? input.pattern ?? "").toString().slice(0, 200);
              bus.emit("worker:activity", { taskId: "orchestrator", msg: `${tool}: ${detail}` });
              bus.emit("agent:tool_use", { agentId: dbSessionId, taskId: "orchestrator", tool, input: detail, ts: Date.now() });
            }
```

- [ ] **Step 2: Add SAP cost event**

After the existing cost update:

Replace:
```typescript
        if (obj.type === "result" && obj.cost_usd != null) {
          db.sessionUpdateCost(dbSessionId, Number(obj.cost_usd), Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0));
        }
```

With:
```typescript
        if (obj.type === "result" && obj.cost_usd != null) {
          const costUsd = Number(obj.cost_usd);
          const tokens = Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0);
          db.sessionUpdateCost(dbSessionId, costUsd, tokens);
          bus.emit("agent:cost", { agentId: dbSessionId, taskId: "orchestrator", costUsd, tokens, ts: Date.now() });
        }
```

- [ ] **Step 3: Run orchestrator tests**

Run: `bun test tests/agents/orchestrator.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "feat: emit SAP events from orchestrator alongside existing events"
```

---

### Task 6: Forward New SAP Events over WebSocket

**Files:**
- Modify: `src/broker/server.ts:39-62` (wireEventBus function)

- [ ] **Step 1: Add SAP event forwarding in wireEventBus**

In `src/broker/server.ts`, in the `wireEventBus()` function, add the new SAP event forwards after the existing forwards:

After line 61 (`forward("message:new");`), add:

```typescript
  // SAP events (fine-grained agent activity)
  forward("agent:spawned");
  forward("agent:ended");
  forward("agent:crashed");
  forward("agent:tool_use");
  forward("agent:thinking");
  forward("agent:text");
  forward("agent:cost");

  // SAP seed events
  forward("seed:response");
  forward("seed:complete");
  forward("seed:idle");
```

- [ ] **Step 2: Run existing server tests**

Run: `bun test tests/broker/server-analytics.test.ts`
Expected: PASS

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: forward SAP events over WebSocket"
```

---

### Task 7: Rewrite Seed Session (tmux → --resume subprocess)

This is the core task. The seed session is rewritten from tmux pane polling to the `--resume` subprocess pattern used by the orchestrator.

**Files:**
- Rewrite: `src/broker/seed-session.ts`
- Create: `tests/broker/seed-session.test.ts`

- [ ] **Step 1: Write failing tests for the new seed session**

Create `tests/broker/seed-session.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-seed-session.db");
const TEST_LOG_DIR = join(import.meta.dir, "test-seed-logs");
let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
});

describe("buildSeedPrompt", () => {
  test("includes task ID and title", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Add auth", description: "JWT-based auth" },
      { id: "app", name: "App", path: "/code/app" },
    );
    expect(prompt).toContain("W-001");
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("JWT-based auth");
  });

  test("includes tree info", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Fix bug" },
      { id: "titan", name: "Titan", path: "/code/titan" },
    );
    expect(prompt).toContain("Titan");
    expect(prompt).toContain("/code/titan");
  });

  test("includes seed_complete protocol", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Test" },
      { id: "t", name: "T", path: "/t" },
    );
    expect(prompt).toContain("seed_complete");
    expect(prompt).toContain("seed_html");
  });
});

describe("buildSeedClaudeArgs", () => {
  test("first message includes --session-id and --system-prompt", async () => {
    const { buildSeedClaudeArgs } = await import("../../src/broker/seed-session");
    const args = buildSeedClaudeArgs("Hello", "sess-123", "/code/app", true, "You are a seed...");
    expect(args).toContain("claude");
    expect(args).toContain("-p");
    expect(args).toContain("Hello");
    expect(args).toContain("--session-id");
    expect(args).toContain("sess-123");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  test("follow-up message includes --resume", async () => {
    const { buildSeedClaudeArgs } = await import("../../src/broker/seed-session");
    const args = buildSeedClaudeArgs("Follow up", "sess-123", "/code/app", false, "");
    expect(args).toContain("--resume");
    expect(args).toContain("sess-123");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--system-prompt");
  });
});

describe("parseSeedEvents", () => {
  test("extracts seed_complete event from stream-json text", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const text = `{"type":"assistant","message":{"content":[{"type":"text","text":"Here is the design.\\n{\\"type\\":\\"seed_complete\\",\\"summary\\":\\"Auth redesign\\",\\"spec\\":\\"## Spec\\\\n..\\"}"}]}}`;
    const events = parseSeedEvents(text);
    const complete = events.find(e => e.type === "seed_complete");
    expect(complete).toBeDefined();
    expect(complete!.summary).toBe("Auth redesign");
  });

  test("extracts seed_html event from stream-json text", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const text = `{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"type\\":\\"seed_html\\",\\"html\\":\\"<div>mockup</div>\\"}"}]}}`;
    const events = parseSeedEvents(text);
    const html = events.find(e => e.type === "seed_html");
    expect(html).toBeDefined();
    expect(html!.html).toBe("<div>mockup</div>");
  });

  test("returns empty array for no events", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const events = parseSeedEvents('{"type":"result","cost_usd":0.01}');
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/broker/seed-session.test.ts`
Expected: FAIL — exports don't exist yet

- [ ] **Step 3: Rewrite seed-session.ts with --resume pattern**

Rewrite `src/broker/seed-session.ts` entirely:

```typescript
// Grove v3 — Seed session manager (SAP-native, tmux-free)
// Manages interactive Claude Code brainstorming sessions using the --resume pattern.
// Each user message spawns a new claude process that resumes the session.
// Outputs are parsed from stream-json and broadcast as SAP events.

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { bus } from "./event-bus";
import { isAlive } from "../agents/stream-parser";
import type { Database } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  html?: string;
  ts: string;
}

interface SeedSession {
  taskId: string;
  sessionId: string;           // claude --session-id / --resume target
  status: "idle" | "running";
  pid: number | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  conversation: ConversationMessage[];
  pendingDescription?: string;
  isFirstMessage: boolean;
  systemPrompt: string;
  treePath: string;
}

type BroadcastFn = (type: string, data: any) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, SeedSession>();
let broadcastFn: BroadcastFn | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the WebSocket broadcast function (called by server.ts) */
export function setSeedBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

/** Spawn a new seed brainstorming session for a task */
export function startSeedSession(
  task: { id: string; title: string; description?: string | null },
  tree: { id: string; name: string; path: string },
  db: Database,
  _logDir: string,
): void {
  const taskId = task.id;

  // If already active, no-op
  if (sessions.has(taskId)) return;

  // Record seed in DB
  db.seedCreate(taskId);

  const systemPrompt = buildSeedPrompt(task, tree);
  const sessionId = `seed-${taskId}-${Date.now()}`;

  const session: SeedSession = {
    taskId,
    sessionId,
    status: "idle",
    pid: null,
    proc: null,
    conversation: [],
    pendingDescription: task.description || undefined,
    isFirstMessage: true,
    systemPrompt,
    treePath: tree.path,
  };

  sessions.set(taskId, session);
  broadcast("seed:started", { taskId });

  // If there's a pending description, auto-send it as the first message
  if (session.pendingDescription) {
    const desc = session.pendingDescription;
    session.pendingDescription = undefined;
    sendSeedMessage(taskId, desc, db);
  }
}

/** Send a user message to the seed session via --resume subprocess */
export function sendSeedMessage(taskId: string, text: string, db: Database): boolean {
  const session = sessions.get(taskId);
  if (!session) return false;

  // If already running, queue the message (will be sent when current finishes)
  if (session.status === "running") {
    session.pendingDescription = text;
    return true;
  }

  // Record user message
  session.conversation.push({
    role: "user",
    content: text,
    ts: new Date().toISOString(),
  });
  db.seedUpdateConversation(taskId, session.conversation);

  // Broadcast user message
  broadcast("seed:message", { taskId, source: "user", content: text });

  // Dispatch the claude process
  dispatchSeedMessage(session, text, db);
  return true;
}

/** Stop a seed session, kill process, cleanup */
export function stopSeedSession(taskId: string, db: Database): void {
  const session = sessions.get(taskId);
  if (!session) return;

  // Kill process if running
  if (session.proc && session.pid && isAlive(session.pid)) {
    try { session.proc.kill(); } catch {}
  }

  // Persist final conversation
  db.seedUpdateConversation(taskId, session.conversation);

  // Cleanup state
  sessions.delete(taskId);
  broadcast("seed:stopped", { taskId });
}

/** Check if a seed session is alive */
export function isSeedSessionActive(taskId: string): boolean {
  return sessions.has(taskId);
}

/** Get conversation history for a seed session */
export function getSeedConversation(taskId: string): ConversationMessage[] {
  const session = sessions.get(taskId);
  return session?.conversation ?? [];
}

// ---------------------------------------------------------------------------
// Prompt builder (exported for testing)
// ---------------------------------------------------------------------------

export function buildSeedPrompt(
  task: { id: string; title: string; description?: string | null },
  tree: { id: string; name: string; path: string },
): string {
  return `You are a Grove seed session — an interactive design brainstorm for a task.

## Task
- **ID:** ${task.id}
- **Title:** ${task.title}
- **Tree:** ${tree.name} (${tree.path})
${task.description ? `- **Description:** ${task.description}` : ""}

## Your Process
1. **Explore** — Read the codebase to understand the relevant parts. Use Grep, Glob, Read to survey the project.
2. **Clarify** — Ask the user clarifying questions one at a time. Prefer multiple-choice questions (A/B/C) when there are clear options.
3. **Propose** — After gathering enough context, propose 2-3 implementation approaches with tradeoffs.
4. **Design** — Present your recommended design section by section, getting sign-off on each piece.
5. **Emit seed** — When the design is finalized, emit a seed artifact (see Completion Protocol below).

## Visual Mockup Protocol
When you want to show the user a visual mockup or diagram, emit the following JSON on its own line:
{"type":"seed_html","html":"<div>your HTML fragment here</div>"}

Use this for UI mockups, architecture diagrams (with styled divs/SVG), or any visual aid.

## Completion Protocol
When the design is fully agreed upon, emit the following JSON on its own line:
{"type":"seed_complete","summary":"A 1-2 sentence summary of what was designed","spec":"The full design specification in markdown"}

This signals that the brainstorm is complete. The spec will be stored and used to guide the worker that implements the task.

## Guidelines
- You have **read-only** access to the codebase. Do NOT create, edit, or delete any files.
- Ask **one question per message** — keep the conversation focused.
- Be concise. Use bullet points and short paragraphs.
- Reference specific files and line numbers when discussing the codebase.
- When proposing approaches, include concrete file paths and function signatures.`;
}

// ---------------------------------------------------------------------------
// Claude CLI argument builder (exported for testing)
// ---------------------------------------------------------------------------

export function buildSeedClaudeArgs(
  message: string,
  sessionId: string,
  treePath: string,
  isFirstMessage: boolean,
  systemPrompt: string,
): string[] {
  const args = ["claude", "-p", message, "--output-format", "stream-json", "--verbose"];

  if (isFirstMessage) {
    args.push("--session-id", sessionId);
    args.push("--system-prompt", systemPrompt);
    args.push("--add-dir", treePath);
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--resume", sessionId);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Internal: dispatch and monitor
// ---------------------------------------------------------------------------

function dispatchSeedMessage(session: SeedSession, text: string, db: Database): void {
  session.status = "running";

  const args = buildSeedClaudeArgs(
    text,
    session.sessionId,
    session.treePath,
    session.isFirstMessage,
    session.systemPrompt,
  );
  session.isFirstMessage = false;

  const proc = Bun.spawn(args, {
    cwd: session.treePath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  session.proc = proc;
  session.pid = proc.pid;

  monitorSeedSession(session, proc, db);
}

async function monitorSeedSession(
  session: SeedSession,
  proc: ReturnType<typeof Bun.spawn>,
  db: Database,
): Promise<void> {
  const { taskId } = session;

  try {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("Seed stdout not available");
    }
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: any;
        try { obj = JSON.parse(trimmed); } catch { continue; }

        // Extract text content from assistant messages
        if (obj.type === "assistant") {
          for (const block of obj.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;

              // Scan for structured seed events in the text
              const events = parseSeedEvents(trimmed);
              for (const event of events) {
                handleSeedEvent(taskId, event, db);
              }
            } else if (block.type === "tool_use") {
              const tool = block.name ?? "tool";
              const input = block.input ?? {};
              const file = input.file_path ?? input.command ?? input.pattern ?? "";
              bus.emit("agent:tool_use", { agentId: session.sessionId, taskId, tool, input: String(file).slice(0, 500), ts: Date.now() });
            }
          }
        }

        // Track cost
        if (obj.type === "result" && obj.cost_usd != null) {
          bus.emit("agent:cost", { agentId: session.sessionId, taskId, costUsd: Number(obj.cost_usd), tokens: Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0), ts: Date.now() });
        }
      }
    }

    await proc.exited;

    // Extract the clean response text (strip JSON events)
    const responseText = extractResponseText(accumulatedText);
    if (responseText) {
      session.conversation.push({
        role: "assistant",
        content: responseText,
        ts: new Date().toISOString(),
      });
      db.seedUpdateConversation(taskId, session.conversation);
      broadcast("seed:message", { taskId, source: "ai", content: responseText });
      bus.emit("seed:response", { taskId, content: responseText, ts: Date.now() });
    }
  } catch (err) {
    broadcast("seed:message", { taskId, source: "ai", content: `Error: ${err}` });
  } finally {
    session.status = "idle";
    session.pid = null;
    session.proc = null;
    bus.emit("seed:idle", { taskId, ts: Date.now() });

    // If there's a queued message, send it now
    if (session.pendingDescription && sessions.has(taskId)) {
      const next = session.pendingDescription;
      session.pendingDescription = undefined;
      sendSeedMessage(taskId, next, db);
    }
  }
}

// ---------------------------------------------------------------------------
// Seed event parser (exported for testing)
// ---------------------------------------------------------------------------

/** Parse structured seed events from a stream-json line */
export function parseSeedEvents(line: string): any[] {
  const events: any[] = [];

  try {
    const obj = JSON.parse(line);
    if (obj.type !== "assistant") return events;

    for (const block of obj.message?.content ?? []) {
      if (block.type !== "text" || !block.text) continue;

      // Look for JSON objects embedded in text
      const text = block.text;
      for (const textLine of text.split("\n")) {
        const trimmed = textLine.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === "seed_complete" || parsed.type === "seed_html") {
            events.push(parsed);
          }
        } catch {}
      }
    }
  } catch {}

  return events;
}

/** Extract clean response text, stripping embedded JSON events */
function extractResponseText(text: string): string {
  const lines = text.split("\n");
  const clean = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return true;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.type !== "seed_complete" && parsed.type !== "seed_html";
    } catch {
      return true;
    }
  });
  return clean.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Seed event handler
// ---------------------------------------------------------------------------

function handleSeedEvent(taskId: string, event: any, db: Database): void {
  switch (event.type) {
    case "seed_html": {
      const session = sessions.get(taskId);
      if (session) {
        session.conversation.push({
          role: "assistant",
          content: "",
          html: event.html,
          ts: new Date().toISOString(),
        });
        db.seedUpdateConversation(taskId, session.conversation);
      }
      broadcast("seed:message", { taskId, source: "ai", content: "", html: event.html });
      break;
    }

    case "seed_complete": {
      db.seedComplete(taskId, event.summary ?? "", event.spec ?? "");
      broadcast("seed:complete", { taskId, summary: event.summary, spec: event.spec });
      bus.emit("seed:complete", { taskId, summary: event.summary ?? "", spec: event.spec ?? "", ts: Date.now() });
      stopSeedSession(taskId, db);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(type: string, data: any): void {
  broadcastFn?.(type, data);
}
```

- [ ] **Step 4: Run seed session tests**

Run: `bun test tests/broker/seed-session.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS (seed session no longer imports tmux)

- [ ] **Step 6: Commit**

```bash
git add src/broker/seed-session.ts tests/broker/seed-session.test.ts
git commit -m "feat: rewrite seed-session from tmux to --resume subprocess pattern"
```

---

### Task 8: Delete tmux.ts and Clean Up References

**Files:**
- Delete: `src/broker/tmux.ts`
- Modify: `src/broker/index.ts:28` (remove tmuxSession)
- Modify: `src/cli/commands/down.ts:23-33` (remove tmux cleanup)

- [ ] **Step 1: Delete tmux.ts**

```bash
rm src/broker/tmux.ts
```

- [ ] **Step 2: Verify no remaining imports of tmux.ts**

Run: `grep -r "from.*tmux" src/ --include="*.ts"`
Expected: No results (seed-session.ts was rewritten in Task 6, no longer imports tmux)

Run: `grep -r "import.*tmux" src/ --include="*.ts"`
Expected: No results

- [ ] **Step 3: Remove tmuxSession from BrokerInfo**

In `src/broker/index.ts`, remove `tmuxSession` from the `BrokerInfo` interface:

Replace:
```typescript
export interface BrokerInfo {
  pid: number;
  port: number;
  url: string;
  tunnelUrl: string | null;  // raw quick-tunnel URL (trycloudflare.com)
  remoteUrl: string | null;  // vanity URL (grove.cloud) or tunnel URL if no domain
  tmuxSession: string;
  startedAt: string;
}
```

With:
```typescript
export interface BrokerInfo {
  pid: number;
  port: number;
  url: string;
  tunnelUrl: string | null;  // raw quick-tunnel URL (trycloudflare.com)
  remoteUrl: string | null;  // vanity URL (grove.cloud) or tunnel URL if no domain
  startedAt: string;
}
```

Remove the `tmuxSession` assignment from the info object (line ~172):

Replace:
```typescript
  const info: BrokerInfo = {
    pid: process.pid,
    port,
    url,
    tunnelUrl,
    remoteUrl,
    tmuxSession: "none",
    startedAt: new Date().toISOString(),
  };
```

With:
```typescript
  const info: BrokerInfo = {
    pid: process.pid,
    port,
    url,
    tunnelUrl,
    remoteUrl,
    startedAt: new Date().toISOString(),
  };
```

Also remove the tmux comment from the file's opening comment (line 2):

Replace:
```typescript
// Grove v3 — Broker main process
// Starts HTTP server, tmux session, orchestrator, and manages lifecycle.
```

With:
```typescript
// Grove v3 — Broker main process
// Starts HTTP server, orchestrator, and manages lifecycle.
```

- [ ] **Step 4: Remove tmux cleanup from down.ts**

In `src/cli/commands/down.ts`, replace the cleanup function:

Replace:
```typescript
function cleanup() {
  // Force kill tmux session if it exists
  Bun.spawnSync(["tmux", "kill-session", "-t", "grove"]);
  // Remove broker.json
  const { join } = require("node:path");
  const { getEnv } = require("../../broker/db");
  const { GROVE_HOME } = getEnv();
  Bun.spawnSync(["rm", "-f", join(GROVE_HOME, "broker.json")]);
  console.log(`${pc.green("✓")} Cleaned up.`);
}
```

With:
```typescript
function cleanup() {
  // Remove broker.json
  const { join } = require("node:path");
  const { getEnv } = require("../../broker/db");
  const { GROVE_HOME } = getEnv();
  Bun.spawnSync(["rm", "-f", join(GROVE_HOME, "broker.json")]);
  console.log(`${pc.green("✓")} Cleaned up.`);
}
```

Also remove the tmux mention from the shutdown message:

Replace:
```typescript
    console.log(`${pc.dim("Broker will clean up tmux session and stop.")}`);
```

With:
```typescript
    console.log(`${pc.dim("Broker will stop.")}`);
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 6: Final grep for any remaining tmux references in source**

Run: `grep -rn "tmux" src/ --include="*.ts"`
Expected: Only hits in `schema-sql.ts` (the `tmux_pane TEXT` column, kept for backward compat) and possibly comments in docs. No functional tmux code.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: delete tmux.ts, remove all tmux references from broker and CLI"
```

---

### Task 9: Update WebSocket Seed Handlers in server.ts

**Files:**
- Modify: `src/broker/server.ts:176-194` (seed WS message handlers)

The seed session API hasn't changed (startSeedSession, sendSeedMessage, stopSeedSession still have the same signatures), so the WebSocket handlers in `server.ts` should already work. But we need to verify and clean up the import.

- [ ] **Step 1: Verify seed imports are still correct**

In `src/broker/server.ts` line 8, the import should still be valid:

```typescript
import { startSeedSession, sendSeedMessage, stopSeedSession, isSeedSessionActive, setSeedBroadcast } from "./seed-session";
```

The rewritten seed-session.ts exports all these same functions.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit (if any changes needed)**

If no changes needed, skip this commit.

---

### Task 10: Verify Full Integration and Clean Up

**Files:**
- All modified files from Tasks 1-8

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All 384+ tests PASS, plus new tests from Tasks 1 and 6.

- [ ] **Step 2: Verify tmux is completely gone**

Run: `grep -rn "tmux" src/ --include="*.ts" | grep -v schema-sql | grep -v "\.d\.ts"`
Expected: No results (only schema-sql.ts has the column definition, which is kept for backward compat)

- [ ] **Step 3: Verify SAP events are defined and wired**

Run: `grep -rn "agent:spawned\|agent:ended\|agent:tool_use\|agent:thinking\|agent:text\|agent:cost\|seed:response\|seed:complete\|seed:idle" src/ --include="*.ts" | head -30`
Expected: Hits in protocol.ts (definitions), types.ts (EventBusMap), worker.ts (emissions), reviewer.ts (emissions), seed-session.ts (emissions), server.ts (forwarding)

- [ ] **Step 4: TypeScript compilation check**

Run: `bun build src/cli/index.ts --outdir /tmp/grove-check --target bun 2>&1 | tail -5`
Expected: No type errors

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: verify SAP integration and tmux removal"
```
