# Orchestrator Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orchestrator's tmux-based interactive session with a multi-call `claude -p --resume` subprocess pattern, eliminating tmux from broker startup and enabling Windows support.

**Architecture:** Each user message spawns a new `claude -p --resume <session-id>` process. Structured JSONL output is parsed in real-time for text (relayed to GUI) and `<grove-event>` tags (handled as broker commands). Orchestrator runs from `~/.grove/` with `--add-dir` for all trees.

**Tech Stack:** Bun subprocess spawning (`Bun.spawn`), Claude Code CLI (`claude -p --resume --output-format stream-json`), existing stream-parser.ts infrastructure

**Spec:** `docs/superpowers/specs/2026-03-30-orchestrator-rewrite-design.md`

**Scope note:** `src/broker/tmux.ts` is NOT deleted in this plan — `seed-session.ts` still depends on it. tmux is removed from broker startup and the orchestrator. Seed session migration is a follow-up. The tmux check in `index.ts` becomes optional (warn instead of fail).

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/agents/orchestrator-events.ts` | Extract `<grove-event>` tags from text, parse as BrokerEvent |
| Create | `tests/agents/orchestrator-events.test.ts` | Tests for event extraction |
| Rewrite | `src/agents/orchestrator.ts` | Replace tmux lifecycle with Bun.spawn + resume pattern |
| Create | `tests/agents/orchestrator.test.ts` | Tests for orchestrator prompt building, session management |
| Modify | `src/broker/index.ts` | Remove tmux session from startup, make orchestrator lazy |
| Modify | `src/broker/server.ts` | Add `/api/orchestrator/reset`, update onChat flow |
| Modify | `src/cli/commands/up.ts` | Remove tmux references from startup output |
| Modify | `src/cli/commands/status.ts` | Remove tmux session reference |
| Modify | `web/src/components/Chat.tsx` | Add "New Session" button |

---

### Task 1: Grove Event Extractor

**Files:**
- Create: `src/agents/orchestrator-events.ts`
- Create: `tests/agents/orchestrator-events.test.ts`

- [ ] **Step 1: Write failing tests for event extraction**

Create `tests/agents/orchestrator-events.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { extractGroveEvents, stripGroveEvents } from "../../src/agents/orchestrator-events";

describe("extractGroveEvents", () => {
  test("extracts a single event from text", () => {
    const text = 'I will create a task for that.\n<grove-event>{"type":"spawn_worker","tree":"titan","task":"W-001","prompt":"Fix auth bug"}</grove-event>\nLet me know if you need anything else.';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("spawn_worker");
    expect(events[0].tree).toBe("titan");
    expect(events[0].task).toBe("W-001");
    expect(events[0].prompt).toBe("Fix auth bug");
  });

  test("extracts multiple events from text", () => {
    const text = '<grove-event>{"type":"spawn_worker","tree":"a","task":"W-001","prompt":"task 1"}</grove-event>\nSome text\n<grove-event>{"type":"task_update","task":"W-002","field":"status","value":"queued"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("spawn_worker");
    expect(events[1].type).toBe("task_update");
  });

  test("returns empty array when no events", () => {
    const text = "Just a normal response with no events.";
    expect(extractGroveEvents(text)).toEqual([]);
  });

  test("skips malformed JSON inside tags", () => {
    const text = '<grove-event>not valid json</grove-event>\n<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"done"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("task_update");
  });

  test("skips events without a type field", () => {
    const text = '<grove-event>{"foo":"bar"}</grove-event>';
    expect(extractGroveEvents(text)).toEqual([]);
  });

  test("handles multiline event tags", () => {
    const text = '<grove-event>{"type":"spawn_worker","tree":"t","task":"W-001","prompt":"a long prompt that spans"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
  });
});

describe("stripGroveEvents", () => {
  test("removes event tags, keeps surrounding text", () => {
    const text = 'Hello.\n<grove-event>{"type":"spawn_worker","tree":"t","task":"W-001","prompt":"x"}</grove-event>\nGoodbye.';
    const stripped = stripGroveEvents(text);
    expect(stripped).toBe("Hello.\n\nGoodbye.");
  });

  test("returns original text when no events", () => {
    const text = "No events here.";
    expect(stripGroveEvents(text)).toBe("No events here.");
  });

  test("trims extra whitespace from removal", () => {
    const text = '<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"done"}</grove-event>';
    const stripped = stripGroveEvents(text);
    expect(stripped.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/agents/orchestrator-events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement orchestrator-events.ts**

Create `src/agents/orchestrator-events.ts`:

```typescript
// Grove v3 — Extract and parse <grove-event> tags from orchestrator text output
import type { BrokerEvent } from "../shared/types";

const GROVE_EVENT_REGEX = /<grove-event>(.*?)<\/grove-event>/gs;

/**
 * Extract all valid BrokerEvent objects from text containing <grove-event> tags.
 * Skips malformed JSON and objects without a `type` field.
 */
export function extractGroveEvents(text: string): BrokerEvent[] {
  const events: BrokerEvent[] = [];
  for (const match of text.matchAll(GROVE_EVENT_REGEX)) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.type && typeof obj.type === "string") {
        events.push(obj as BrokerEvent);
      }
    } catch {
      // Malformed JSON — skip
    }
  }
  return events;
}

/**
 * Remove all <grove-event>...</grove-event> tags from text, returning
 * only the human-readable content for display in the GUI.
 */
export function stripGroveEvents(text: string): string {
  return text.replace(GROVE_EVENT_REGEX, "").replace(/\n{3,}/g, "\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/agents/orchestrator-events.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator-events.ts tests/agents/orchestrator-events.test.ts
git commit -m "feat(orchestrator): add grove-event tag extractor (#23)"
```

---

### Task 2: Rewrite orchestrator.ts

**Files:**
- Rewrite: `src/agents/orchestrator.ts`
- Create: `tests/agents/orchestrator.test.ts`

- [ ] **Step 1: Write tests for the new orchestrator**

Create `tests/agents/orchestrator.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-orchestrator.db");
let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// We test buildOrchestratorPrompt and session state management.
// We cannot test the actual claude subprocess in unit tests.

describe("buildOrchestratorPrompt", () => {
  // Import after module is rewritten
  test("includes trees in prompt", async () => {
    db.treeUpsert({ id: "titan", name: "Titan", path: "/code/titan", github: "org/titan" });
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("titan");
    expect(prompt).toContain("/code/titan");
    expect(prompt).toContain("org/titan");
  });

  test("includes active tasks in prompt", async () => {
    db.treeUpsert({ id: "t", name: "T", path: "/t" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "t", "Fix bug", "active"]);
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("W-001");
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("active");
  });

  test("includes grove-event protocol instructions", async () => {
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("<grove-event>");
    expect(prompt).toContain("spawn_worker");
    expect(prompt).toContain("task_update");
  });

  test("includes recent messages when available", async () => {
    db.addMessage("user", "Fix the auth module");
    db.addMessage("orchestrator", "I will create a task for that");
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("Fix the auth module");
    expect(prompt).toContain("I will create a task for that");
  });
});

describe("buildClaudeArgs", () => {
  test("first call uses --session-id and --system-prompt", async () => {
    db.treeUpsert({ id: "t", name: "T", path: "/t" });
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("test message", "uuid-123", db, true);
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-123");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("-p");
    expect(args).toContain("test message");
  });

  test("resume call uses --resume instead of --session-id", async () => {
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("follow up", "uuid-123", db, false);
    expect(args).toContain("--resume");
    expect(args).toContain("uuid-123");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--system-prompt");
  });

  test("includes --add-dir for each tree", async () => {
    db.treeUpsert({ id: "a", name: "A", path: "/code/a" });
    db.treeUpsert({ id: "b", name: "B", path: "/code/b" });
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("msg", "uuid", db, true);
    const addDirIndices = args.reduce((acc: number[], arg: string, i: number) => {
      if (arg === "--add-dir") acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices.length).toBe(2);
    expect(args[addDirIndices[0] + 1]).toBe("/code/a");
    expect(args[addDirIndices[1] + 1]).toBe("/code/b");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/agents/orchestrator.test.ts`
Expected: FAIL — current module doesn't export `buildOrchestratorPrompt` or `buildClaudeArgs`

- [ ] **Step 3: Rewrite orchestrator.ts**

Replace the entire contents of `src/agents/orchestrator.ts`:

```typescript
// Grove v3 — Orchestrator agent lifecycle
// The orchestrator uses multi-call `claude -p --resume` subprocess pattern.
// Each user message spawns a new claude process that resumes a persistent session.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { isAlive } from "./stream-parser";
import { extractGroveEvents, stripGroveEvents } from "./orchestrator-events";
import type { Database } from "../broker/db";
import { getEnv } from "../broker/db";

// ---------------------------------------------------------------------------
// Session state (in-memory, ephemeral to broker lifetime)
// ---------------------------------------------------------------------------

interface OrchestratorSession {
  sessionId: string;
  status: "idle" | "running";
  pid: number | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  startedAt: string;
  messageQueue: string[];
  isFirstMessage: boolean;
}

let session: OrchestratorSession | null = null;
let dbRef: Database | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the orchestrator (called on broker startup). Does NOT spawn a process. */
export function init(db: Database): void {
  dbRef = db;
  // Lazy — first process spawns on first user message
}

/** Send a message to the orchestrator. Spawns or resumes as needed. */
export function sendMessage(text: string, db: Database): void {
  if (!session) {
    session = {
      sessionId: crypto.randomUUID(),
      status: "idle",
      pid: null,
      proc: null,
      startedAt: new Date().toISOString(),
      messageQueue: [],
      isFirstMessage: true,
    };
  }

  if (session.status === "running") {
    session.messageQueue.push(text);
    return;
  }

  dispatchMessage(text, db);
}

/** Reset the orchestrator session (user-initiated "New Session") */
export function resetSession(): void {
  if (session?.proc && session.pid && isAlive(session.pid)) {
    try { session.proc.kill(); } catch {}
  }
  session = null;
}

/** Check if orchestrator is currently processing a message */
export function isRunning(): boolean {
  if (!session) return false;
  if (session.status === "running" && session.pid) {
    return isAlive(session.pid);
  }
  return session.status === "running";
}

/** Stop the orchestrator (called on grove down) */
export function stop(db: Database): void {
  if (session?.proc && session.pid && isAlive(session.pid)) {
    try { session.proc.kill(); } catch {}
  }
  session = null;
  dbRef = null;
}

/** Get session ID (for status display) */
export function getSessionId(): string | null {
  return session?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Prompt builder (exported for testing)
// ---------------------------------------------------------------------------

/** Build the orchestrator's system prompt */
export function buildOrchestratorPrompt(db: Database): string {
  const trees = db.allTrees();
  const treeList = trees.map(t => `- ${t.id}: ${t.path}${t.github ? ` (${t.github})` : ""}`).join("\n");

  const activeTasks = db.all<{ id: string; title: string; status: string; tree_id: string }>(
    "SELECT id, title, status, tree_id FROM tasks WHERE status NOT IN ('completed', 'merged', 'failed') ORDER BY created_at DESC LIMIT 20"
  );
  const taskList = activeTasks.length > 0
    ? activeTasks.map(t => `- ${t.id}: [${t.status}] ${t.title} (${t.tree_id || "no tree"})`).join("\n")
    : "No active tasks.";

  // Include recent messages for conversational continuity on first message
  const recentMsgs = db.recentMessages("main", 20);
  let msgHistory = "";
  if (recentMsgs.length > 0) {
    msgHistory = "\n\n## Recent Conversation\n" + recentMsgs
      .reverse()
      .map(m => `[${m.source}] ${m.content}`)
      .join("\n");
  }

  return `You are the Grove orchestrator. You plan work, decompose tasks across repos (called "trees"), and delegate to workers.

## Your Role
- You converse with the user (messages arrive as prompts)
- You plan and decompose tasks
- You delegate implementation to workers by emitting structured events
- You DO NOT write code yourself — workers do that
- You have read-only access to all trees for analysis

## Available Trees
${treeList || "No trees configured yet."}

## Active Tasks
${taskList}

## Emitting Events
When you need the broker to take action, emit an event using this exact format:

<grove-event>{"type":"spawn_worker","tree":"tree-id","task":"W-001","prompt":"description of what to implement"}</grove-event>
<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"planned"}</grove-event>

Important: Always wrap events in <grove-event></grove-event> tags. The broker parses these tags to execute your commands.

## Guidelines
- When the user asks you to do something, analyze whether it needs decomposition across trees
- For single-tree tasks, emit one spawn_worker event
- For cross-tree tasks, emit multiple spawn_worker events with depends_on fields
- Always explain your plan to the user before spawning workers
- When workers complete, summarize results for the user${msgHistory}`;
}

/** Build the claude CLI arguments array (exported for testing) */
export function buildClaudeArgs(
  message: string,
  sessionId: string,
  db: Database,
  isFirstMessage: boolean,
): string[] {
  const args = ["claude", "-p", message, "--output-format", "stream-json", "--verbose"];

  if (isFirstMessage) {
    args.push("--session-id", sessionId);
    args.push("--system-prompt", buildOrchestratorPrompt(db));
    // Add all tree directories for read access
    for (const tree of db.allTrees()) {
      args.push("--add-dir", tree.path);
    }
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--resume", sessionId);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Internal: dispatch and monitor
// ---------------------------------------------------------------------------

/** Dispatch a message to the orchestrator subprocess */
function dispatchMessage(text: string, db: Database): void {
  if (!session) return;

  session.status = "running";

  const { GROVE_HOME } = getEnv();
  const cwd = GROVE_HOME;
  mkdirSync(cwd, { recursive: true });

  const args = buildClaudeArgs(text, session.sessionId, db, session.isFirstMessage);
  session.isFirstMessage = false;

  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  session.proc = proc;
  session.pid = proc.pid;

  // Create session record in DB (for cost tracking)
  const dbSessionId = `orch-${Date.now()}`;
  db.sessionCreate(dbSessionId, null, "orchestrator", proc.pid);

  // Monitor stdout asynchronously
  monitorOrchestrator(proc, db, dbSessionId);
}

/** Monitor orchestrator subprocess stdout, relay text and handle events */
async function monitorOrchestrator(
  proc: ReturnType<typeof Bun.spawn>,
  db: Database,
  dbSessionId: string,
): Promise<void> {
  try {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);

      // Parse stream-json lines
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: any;
        try { obj = JSON.parse(trimmed); } catch { continue; }

        // Handle assistant text content
        if (obj.type === "assistant") {
          for (const block of obj.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;

              // Extract and handle grove events
              const events = extractGroveEvents(accumulatedText);
              for (const event of events) {
                handleOrchestratorEvent(event, db);
              }

              // Relay clean text (without event tags) to GUI
              const cleanText = stripGroveEvents(block.text).trim();
              if (cleanText) {
                bus.emit("message:new", {
                  message: {
                    id: 0,
                    source: "orchestrator",
                    channel: "main",
                    content: cleanText,
                    created_at: new Date().toISOString(),
                  },
                });
              }
            } else if (block.type === "tool_use") {
              const tool = block.name ?? "tool";
              const input = block.input ?? {};
              const detail = (input.file_path ?? input.command ?? input.pattern ?? "").toString().slice(0, 200);
              bus.emit("worker:activity", { taskId: "orchestrator", msg: `${tool}: ${detail}` });
            }
          }
        }

        // Handle cost/result
        if (obj.type === "result" && obj.cost_usd != null) {
          db.sessionUpdateCost(dbSessionId, Number(obj.cost_usd), Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0));
        }
      }
    }

    // Wait for process exit
    const exitCode = await proc.exited;
    db.sessionEnd(dbSessionId, exitCode === 0 ? "completed" : "failed");

    // Store the full orchestrator response in messages DB
    if (accumulatedText.trim()) {
      const cleanFull = stripGroveEvents(accumulatedText).trim();
      if (cleanFull) {
        db.addMessage("orchestrator", cleanFull);
      }
    }
  } catch (err) {
    db.sessionEnd(dbSessionId, "crashed");
    db.addEvent(null, dbSessionId, "orchestrator_crashed", `Orchestrator crashed: ${err}`);
  } finally {
    // Mark idle and dispatch next queued message
    if (session) {
      session.status = "idle";
      session.pid = null;
      session.proc = null;

      if (session.messageQueue.length > 0 && dbRef) {
        const next = session.messageQueue.shift()!;
        dispatchMessage(next, dbRef);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event handler (reused from existing code)
// ---------------------------------------------------------------------------

function handleOrchestratorEvent(event: any, db: Database): void {
  switch (event.type) {
    case "spawn_worker": {
      const taskId = db.nextTaskId("W");
      db.run(
        "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'queued')",
        [taskId, event.tree, event.prompt, event.prompt, event.path_name ?? "development"]
      );
      db.addEvent(taskId, null, "task_created", `Task created by orchestrator: ${event.prompt}`);
      const task = db.taskGet(taskId);
      if (task) {
        bus.emit("task:created", { task });
        const { enqueue } = require("../broker/dispatch");
        enqueue(taskId);
      }
      break;
    }

    case "task_update":
      if (event.field === "status" && event.task) {
        db.taskSetStatus(event.task, event.value as string);
        bus.emit("task:status", { taskId: event.task, status: event.value as string });
      }
      break;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/agents/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass (some existing tests may reference old orchestrator exports — fix any import issues)

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts tests/agents/orchestrator.test.ts
git commit -m "feat(orchestrator): rewrite to claude -p --resume subprocess pattern (#23)"
```

---

### Task 3: Update Broker Startup (index.ts)

**Files:**
- Modify: `src/broker/index.ts`

- [ ] **Step 1: Remove tmux session creation and make orchestrator lazy**

In `src/broker/index.ts`, make these changes:

1. Remove the tmux import and check:
```typescript
// REMOVE these lines:
// import * as tmux from "./tmux";
// if (!tmux.isTmuxAvailable()) {
//   throw new Error("tmux is not installed...");
// }
// tmux.createSession();
```

2. Replace the orchestrator spawn with init:
```typescript
// REPLACE: orchestrator.spawn(db, GROVE_LOG_DIR);
// WITH:
orchestrator.init(db);
```

3. Update the onChat callback to pass db:
```typescript
onChat: (text) => {
  orchestrator.sendMessage(text, db);
},
```

4. Update the onOrchestratorCrash handler:
```typescript
onOrchestratorCrash: () => {
  // No-op — orchestrator is lazy, will respawn on next message
  console.log("Orchestrator process ended — will restart on next message");
},
```

5. Update shutdown to not kill tmux session:
```typescript
// REMOVE: tmux.killSession();
// Keep: orchestrator.stop(db);
```

6. Remove `tmuxSession` from BrokerInfo (or set to "none"):
```typescript
tmuxSession: "none",
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/broker/index.ts
git commit -m "refactor(broker): remove tmux from startup, make orchestrator lazy (#23)"
```

---

### Task 4: Update Server — Add Reset Endpoint

**Files:**
- Modify: `src/broker/server.ts`

- [ ] **Step 1: Add `/api/orchestrator/reset` endpoint**

Add before the `// GET /api/events` block in `src/broker/server.ts`:

```typescript
    // POST /api/orchestrator/reset — start a fresh orchestrator session
    if (path === "/api/orchestrator/reset" && req.method === "POST") {
      const { resetSession } = await import("../agents/orchestrator");
      resetSession();
      db.addEvent(null, null, "orchestrator_rotated", "Orchestrator session reset by user");
      return json({ ok: true, message: "Orchestrator session reset. Next message starts a fresh session." });
    }
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat(server): add /api/orchestrator/reset endpoint (#23)"
```

---

### Task 5: Update CLI Commands

**Files:**
- Modify: `src/cli/commands/up.ts`
- Modify: `src/cli/commands/status.ts`

- [ ] **Step 1: Update up.ts — remove tmux references**

In `src/cli/commands/up.ts`, remove the `tmux:` line from the startup output. Change:
```typescript
    console.log(`  tmux:    ${pc.dim("tmux attach -t grove")}`);
```
to remove this line entirely. The orchestrator no longer lives in tmux.

- [ ] **Step 2: Update status.ts — remove tmux reference**

In `src/cli/commands/status.ts`, remove:
```typescript
    console.log(`  tmux:    ${info.tmuxSession}`);
```

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/up.ts src/cli/commands/status.ts
git commit -m "refactor(cli): remove tmux references from up and status commands (#23)"
```

---

### Task 6: GUI — New Session Button

**Files:**
- Modify: `web/src/components/Chat.tsx`

- [ ] **Step 1: Read Chat.tsx to understand current structure**

Read `web/src/components/Chat.tsx` and find the header area where a "New Session" button should go.

- [ ] **Step 2: Add New Session button to Chat header**

Add a "New Session" button in the Chat panel header. When clicked, it sends a POST to `/api/orchestrator/reset` via the `api` client:

```tsx
// In the Chat header area, add:
<button
  onClick={async () => {
    try {
      await api("/api/orchestrator/reset", { method: "POST" });
    } catch {}
  }}
  className="text-zinc-500 hover:text-zinc-300 text-[10px] px-2 py-0.5 rounded border border-zinc-700 hover:border-zinc-600 transition-colors"
  title="Start a fresh orchestrator session"
>
  New Session
</button>
```

- [ ] **Step 3: Verify TypeScript compiles and build succeeds**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit && npm run build`
Expected: Clean compile and successful build

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Chat.tsx
git commit -m "feat(gui): add New Session button to Chat panel (#23)"
```

---

### Task 7: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript check**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 3: Build web frontend**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Verify no remaining tmux imports in orchestrator or index**

Run: `grep -r "import.*tmux" src/agents/orchestrator.ts src/broker/index.ts`
Expected: No matches (tmux only remains in seed-session.ts)

- [ ] **Step 5: Verify acceptance criteria from issue #23**

- [x] Orchestrator runs via `claude -p` with JSONL output (stream-json)
- [x] Events parsed from `<grove-event>` tags in stream-json text blocks
- [x] User messages relayed via subprocess spawning (not tmux send-keys)
- [x] No tmux dependency in broker startup
- [x] No regression in message relay to web GUI
- [x] Existing worker stream parsing unaffected
- [x] New Session button in GUI for user-initiated session reset
- [ ] Context rotation via `--resume` works (manual test — run `grove up`, send multiple messages)
