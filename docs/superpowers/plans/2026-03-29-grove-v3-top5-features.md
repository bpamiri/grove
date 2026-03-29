# Grove v3 Top 5 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 strategic features that take Grove from working prototype to shippable open-source product: reliable orchestrator communication, notifications, analytics dashboard, binary distribution, and integration tests.

**Architecture:** The plan is ordered by dependency: (1) structured orchestrator JSONL replaces fragile tmux scraping, (2) integration tests cover the new + existing pipeline, (3) notification system hooks into the event bus, (4) analytics dashboard visualizes collected data, (5) binary distribution packages everything for users.

**Tech Stack:** Bun runtime, TypeScript, SQLite, React 19, Tailwind CSS 4, Vite, Cloudflare Workers, GitHub Actions, Homebrew

**Issues:** #23, #24, #25, #26, #27

---

## Phase 1: Structured Orchestrator Communication (Issue #23)

### Task 1: Extract orchestrator event handling into a reusable module

**Files:**
- Create: `src/agents/orchestrator-events.ts`
- Modify: `src/agents/orchestrator.ts`
- Test: `tests/agents/orchestrator-events.test.ts`

- [ ] **Step 1: Write failing test for event parsing**

```typescript
// tests/agents/orchestrator-events.test.ts
import { describe, test, expect } from "bun:test";
import { parseOrchestratorEvent } from "../../src/agents/orchestrator-events";

describe("parseOrchestratorEvent", () => {
  test("parses spawn_worker event", () => {
    const event = parseOrchestratorEvent('{"type":"spawn_worker","tree":"api","task":"W-001","prompt":"Fix auth"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("spawn_worker");
    expect(event!.tree).toBe("api");
  });

  test("parses user_response event", () => {
    const event = parseOrchestratorEvent('{"type":"user_response","text":"I will create a task"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("user_response");
  });

  test("parses task_update event", () => {
    const event = parseOrchestratorEvent('{"type":"task_update","task":"W-001","field":"status","value":"completed"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("task_update");
  });

  test("returns null for non-JSON", () => {
    expect(parseOrchestratorEvent("just some text")).toBeNull();
  });

  test("returns null for JSON without type", () => {
    expect(parseOrchestratorEvent('{"foo":"bar"}')).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseOrchestratorEvent("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agents/orchestrator-events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the event parser**

```typescript
// src/agents/orchestrator-events.ts
// Parses structured events from orchestrator output (JSONL or text lines)
import { bus } from "../broker/event-bus";
import type { Database } from "../broker/db";
import type { BrokerEvent } from "../shared/types";

/** Parse a single line as an orchestrator event. Returns null if not a valid event. */
export function parseOrchestratorEvent(line: string): BrokerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.type && typeof obj.type === "string") {
      return obj as BrokerEvent;
    }
  } catch {
    // Not JSON
  }
  return null;
}

/** Handle a parsed orchestrator event — update DB and emit bus events */
export function handleOrchestratorEvent(event: BrokerEvent, db: Database): void {
  switch (event.type) {
    case "spawn_worker": {
      const e = event as any;
      bus.emit("task:created", {
        task: {
          id: e.task,
          tree_id: e.tree,
          parent_task_id: null,
          title: e.prompt,
          description: e.prompt,
          status: "queued",
          current_step: null,
          step_index: 0,
          paused: 0,
          path_name: "development",
          priority: 0,
          depends_on: e.depends_on ?? null,
          branch: null,
          worktree_path: null,
          pr_url: null,
          pr_number: null,
          cost_usd: 0,
          tokens_used: 0,
          gate_results: null,
          session_summary: null,
          files_modified: null,
          retry_count: 0,
          max_retries: 2,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          github_issue: null,
        },
      });
      break;
    }

    case "user_response": {
      const e = event as any;
      db.addMessage("orchestrator", e.text);
      bus.emit("message:new", {
        message: {
          id: 0,
          source: "orchestrator",
          channel: "main",
          content: e.text,
          created_at: new Date().toISOString(),
        },
      });
      break;
    }

    case "task_update": {
      const e = event as any;
      if (e.field === "status") {
        const newStatus = e.value as string;
        if (newStatus === "completed") {
          db.run(
            "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
            [e.task]
          );
          db.addEvent(e.task, null, "task_completed", "Marked completed by orchestrator");
        } else if (newStatus === "failed") {
          db.run(
            "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
            [e.task]
          );
          db.addEvent(e.task, null, "task_failed", "Marked failed by orchestrator");
        } else {
          db.taskSetStatus(e.task, newStatus);
        }
        bus.emit("task:status", { taskId: e.task, status: newStatus });
      }
      break;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agents/orchestrator-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator-events.ts tests/agents/orchestrator-events.test.ts
git commit -m "refactor: (#23) extract orchestrator event parsing into reusable module"
```

### Task 2: Rewrite orchestrator to use pipe-based JSONL communication

**Files:**
- Modify: `src/agents/orchestrator.ts` (major rewrite)
- Modify: `src/broker/index.ts` (update spawn call)
- Modify: `src/broker/server.ts` (update onChat relay)
- Modify: `src/monitor/health.ts` (update orchestrator health check)

The orchestrator currently runs as an interactive Claude Code session in tmux. This task rewrites it to run as a `claude -p` subprocess with piped stdin/stdout, using JSONL for structured output.

- [ ] **Step 1: Rewrite orchestrator.ts**

Replace the full contents of `src/agents/orchestrator.ts` with:

```typescript
// Grove v3 — Orchestrator agent lifecycle (pipe-based JSONL communication)
// The orchestrator runs as a `claude -p` subprocess with stdin/stdout pipes.
// The broker writes user messages to stdin, reads JSONL events from stdout.
import { join } from "node:path";
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { parseOrchestratorEvent, handleOrchestratorEvent } from "./orchestrator-events";
import type { Database } from "../broker/db";

// Context rotation threshold: rotate when log exceeds this size
const LOG_SIZE_ROTATION_THRESHOLD = 500_000; // ~500KB

export interface OrchestratorState {
  sessionId: string;
  pid: number | null;
  logPath: string;
  logDir: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  stopMonitor: (() => void) | null;
}

let state: OrchestratorState | null = null;
let dbRef: Database | null = null;
let rotationCheckInterval: ReturnType<typeof setInterval> | null = null;

/** Build the orchestrator's system prompt */
function buildPrompt(db: Database, contextSummary?: string): string {
  const trees = db.allTrees();
  const treeList = trees.map(t => `- ${t.id}: ${t.path}${t.github ? ` (${t.github})` : ""}`).join("\n");

  const activeTasks = db.all<{ id: string; title: string; status: string; tree_id: string }>(
    "SELECT id, title, status, tree_id FROM tasks WHERE status NOT IN ('completed', 'merged', 'failed') ORDER BY created_at DESC LIMIT 20"
  );
  const taskList = activeTasks.length > 0
    ? activeTasks.map(t => `- ${t.id}: [${t.status}] ${t.title} (${t.tree_id || "no tree"})`).join("\n")
    : "No active tasks.";

  const parts: string[] = [];

  parts.push(`You are the Grove orchestrator. You plan work, decompose tasks across repos (called "trees"), and delegate to workers.

## Your Role
- You converse with the user (messages arrive via stdin)
- You plan and decompose tasks
- You delegate implementation to workers by emitting structured JSON events
- You DO NOT write code yourself — workers do that
- You have read-only access to all trees for analysis

## Available Trees
${treeList || "No trees configured yet."}

## Active Tasks
${taskList}

## Emitting Events
When you need the broker to take action, output a JSON object on its own line:
- Spawn a worker: {"type":"spawn_worker","tree":"tree-id","task":"W-001","prompt":"description of what to implement"}
- Update task status: {"type":"task_update","task":"W-001","field":"status","value":"completed"}
  Valid statuses: draft, queued, active, completed, failed
- Respond to user: {"type":"user_response","text":"your response here"}

IMPORTANT: Always emit events as valid JSON on their own line. Do not wrap them in markdown code blocks.

## Guidelines
- When the user asks you to do something, analyze whether it needs decomposition across trees
- For single-tree tasks, emit one spawn_worker event
- For cross-tree tasks, emit multiple spawn_worker events with depends_on fields
- Always explain your plan to the user before spawning workers
- Monitor worker progress via events the broker sends you
- When workers complete, summarize results for the user`);

  if (contextSummary) {
    parts.push(`\n## Context from Previous Session\nYou are resuming from a previous orchestrator session. Here is the context summary:\n${contextSummary}`);
  }

  // Inject recent messages for continuity
  const recentMsgs = db.recentMessages("main", 20);
  if (recentMsgs.length > 0) {
    const msgHistory = recentMsgs
      .reverse()
      .map(m => `[${m.source}] ${m.content}`)
      .join("\n");
    parts.push(`\n## Recent Conversation\n${msgHistory}`);
  }

  return parts.join("\n");
}

/** Spawn the orchestrator as a `claude -p` subprocess with piped I/O */
export function spawn(db: Database, logDir: string, contextSummary?: string): OrchestratorState {
  if (state?.pid && state.proc && isAlive(state.pid)) {
    return state;
  }

  mkdirSync(logDir, { recursive: true });
  dbRef = db;

  const sessionId = `orch-${Date.now()}`;
  const logPath = join(logDir, `${sessionId}.jsonl`);
  const prompt = buildPrompt(db, contextSummary);

  // Spawn claude in print mode with JSONL output
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const pid = proc.pid;

  // Get stdin writer for sending messages
  let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  if (proc.stdin && typeof proc.stdin !== "number") {
    stdinWriter = (proc.stdin as WritableStream<Uint8Array>).getWriter();
  }

  db.sessionCreate(sessionId, null, "orchestrator", pid, undefined, logPath);
  db.addEvent(null, sessionId, "orchestrator_started", `Orchestrator spawned (PID: ${pid})`);

  // Start monitoring stdout for JSONL events and responses
  const stopMonitor = monitorOutput(proc, logPath, db);

  state = { sessionId, pid, logPath, logDir, proc, stdinWriter, stopMonitor };

  bus.emit("orchestrator:started", { sessionId, pid: pid ?? 0 });

  // Start rotation check (every 60 seconds)
  if (!rotationCheckInterval) {
    rotationCheckInterval = setInterval(() => checkRotation(db), 60_000);
  }

  return state;
}

/** Send a message to the orchestrator via stdin pipe */
export function sendMessage(text: string): boolean {
  if (!state?.stdinWriter) return false;
  try {
    const encoded = new TextEncoder().encode(text + "\n");
    state.stdinWriter.write(encoded);
    return true;
  } catch {
    return false;
  }
}

/** Get current orchestrator state */
export function getState(): OrchestratorState | null {
  return state;
}

/** Check if orchestrator is running */
export function isRunning(): boolean {
  if (!state?.pid) return false;
  return isAlive(state.pid);
}

/** Stop the orchestrator */
export function stop(db: Database): void {
  if (rotationCheckInterval) {
    clearInterval(rotationCheckInterval);
    rotationCheckInterval = null;
  }
  if (state) {
    state.stopMonitor?.();
    try { state.stdinWriter?.close(); } catch {}
    try { state.proc?.kill(); } catch {}
    db.sessionEnd(state.sessionId, "stopped");
    state = null;
  }
}

/** Check if a PID is alive */
function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stdout monitor — reads JSONL from orchestrator, relays events and messages
// ---------------------------------------------------------------------------

function monitorOutput(proc: ReturnType<typeof Bun.spawn>, logPath: string, db: Database): () => void {
  let stopped = false;

  const run = async () => {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const logFile = Bun.file(logPath);
    const writer = logFile.writer();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        writer.write(text);
        writer.flush();

        // Process complete lines
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const obj = JSON.parse(trimmed);

            // Handle stream-json assistant messages — look for text content and events
            if (obj.type === "assistant") {
              for (const block of obj.message?.content ?? []) {
                if (block.type === "text" && block.text) {
                  // Scan text for embedded JSON events (orchestrator outputs them as text)
                  for (const textLine of block.text.split("\n")) {
                    const event = parseOrchestratorEvent(textLine);
                    if (event) {
                      handleOrchestratorEvent(event, db);
                    }
                  }
                  // Also relay non-event text as orchestrator messages
                  const nonEventText = block.text.split("\n")
                    .filter((l: string) => !parseOrchestratorEvent(l))
                    .join("\n")
                    .trim();
                  if (nonEventText && nonEventText.length > 10) {
                    db.addMessage("orchestrator", nonEventText);
                    bus.emit("message:new", {
                      message: {
                        id: 0,
                        source: "orchestrator",
                        channel: "main",
                        content: nonEventText,
                        created_at: new Date().toISOString(),
                      },
                    });
                  }
                }
              }
            }

            // Handle result event (session complete with cost)
            if (obj.type === "result" && obj.cost_usd != null) {
              db.sessionUpdateCost(
                state?.sessionId ?? "",
                Number(obj.cost_usd),
                Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0)
              );
            }
          } catch {
            // Not JSON — check for raw event lines
            const event = parseOrchestratorEvent(trimmed);
            if (event) {
              handleOrchestratorEvent(event, db);
            }
          }
        }
      }
    } catch {
      // Stream ended or error
    } finally {
      writer.end();
    }

    // Process exited — handle completion
    if (!stopped) {
      const exitCode = await proc.exited;
      if (state) {
        db.sessionEnd(state.sessionId, exitCode === 0 ? "completed" : "crashed");
        if (exitCode !== 0) {
          db.addEvent(null, state.sessionId, "orchestrator_crashed", `Orchestrator exited with code ${exitCode}`);
        }
      }
    }
  };

  run();
  return () => { stopped = true; };
}

// ---------------------------------------------------------------------------
// Context rotation
// ---------------------------------------------------------------------------

function checkRotation(db: Database): void {
  if (!state?.logPath) return;
  try {
    if (!existsSync(state.logPath)) return;
    const stat = statSync(state.logPath);
    if (stat.size >= LOG_SIZE_ROTATION_THRESHOLD) {
      rotate(db);
    }
  } catch {}
}

function rotate(db: Database): void {
  if (!state) return;

  const oldSessionId = state.sessionId;
  const logDir = state.logDir;

  // Build context summary from DB state
  const activeTasks = db.all<{ id: string; title: string; status: string; tree_id: string }>(
    "SELECT id, title, status, tree_id FROM tasks WHERE status NOT IN ('completed', 'merged', 'failed') ORDER BY created_at DESC LIMIT 30"
  );
  const recentEvents = db.recentEvents(20);

  const summary = [
    "## Active Tasks",
    ...activeTasks.map(t => `- ${t.id} [${t.status}] ${t.title} (tree: ${t.tree_id || "none"})`),
    "",
    "## Recent Events",
    ...recentEvents.map(e => `- [${e.event_type}] ${e.summary ?? ""} (task: ${e.task_id ?? "system"})`),
  ].join("\n");

  // Stop old session
  stop(db);
  db.sessionEnd(oldSessionId, "rotated");
  db.addEvent(null, oldSessionId, "orchestrator_rotated", "Session rotated due to context size");

  // Start new session with summary
  const newState = spawn(db, logDir, summary);
  bus.emit("orchestrator:rotated", { oldSessionId, newSessionId: newState.sessionId });
}
```

- [ ] **Step 2: Update broker index.ts — remove tmux dependency for orchestrator**

In `src/broker/index.ts`, the orchestrator no longer needs tmux for its own session. However, tmux is still used for seed sessions and is still needed for `createSession()` at startup. The key change: `onChat` now calls `orchestrator.sendMessage(text)` which writes to stdin pipe instead of tmux.

No code change needed — `onChat` already calls `orchestrator.sendMessage(text)` and the interface is the same. The tmux session is still created for seed sessions.

- [ ] **Step 3: Update health monitor — check orchestrator PID directly**

In `src/monitor/health.ts`, the `checkOrchestrator` function already checks PID liveness from the sessions DB. The new orchestrator stores its PID the same way. No change needed.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All existing tests pass. The orchestrator rewrite doesn't change any tested interfaces.

- [ ] **Step 5: Manual smoke test**

Run: `bun run dev -- up`
Verify:
- Orchestrator process spawns (check `ps aux | grep claude`)
- Sending a chat message via GUI reaches orchestrator
- Orchestrator responses appear in GUI chat

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "feat: (#23) rewrite orchestrator to pipe-based JSONL communication

Replace tmux capture-pane scraping with direct stdin/stdout pipes.
Orchestrator now runs as claude -p with stream-json output.
Events parsed from JSONL stream instead of regex on terminal output."
```

### Task 3: Clean up tmux.ts — remove orchestrator-only functions

**Files:**
- Modify: `src/broker/tmux.ts` (no removals — all functions are still used by seed sessions)

After reviewing, all tmux functions (`sendKeys`, `capturePane`, `runInWindow`, `windowTarget`, `panePid`) are still used by `src/broker/seed-session.ts`. No cleanup needed. The tmux module stays as-is.

- [ ] **Step 1: Verify tmux usage**

Run: `grep -r "tmux\." src/ --include="*.ts" | grep -v "orchestrator.ts" | grep -v "node_modules"`
Expected: See references in `seed-session.ts` and `broker/index.ts`

- [ ] **Step 2: Commit (no-op — document decision)**

```bash
git commit --allow-empty -m "docs: (#23) tmux module retained for seed sessions — no cleanup needed"
```

---

## Phase 2: Integration Test Suite (Issue #27)

### Task 4: Test fixtures and helpers

**Files:**
- Create: `tests/fixtures/helpers.ts`

- [ ] **Step 1: Write test fixture helpers**

```typescript
// tests/fixtures/helpers.ts
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create an in-memory test database with schema applied */
export function createTestDb(): Database {
  const path = join(mkdtempSync(join(tmpdir(), "grove-test-")), "test.db");
  const db = new Database(path);
  db.initFromString(SCHEMA_SQL);
  return db;
}

/** Create a temporary git repo with an initial commit. Returns the repo path. */
export function createFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-repo-"));
  Bun.spawnSync(["git", "init"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@grove.dev"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Grove Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test repo\n");
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
  return dir;
}

/** Create a fixture repo and register it as a tree in the DB. Returns { db, repoPath, treeId }. */
export function createFixtureTree(opts?: { treeId?: string; github?: string }): {
  db: Database;
  repoPath: string;
  treeId: string;
} {
  const db = createTestDb();
  const repoPath = createFixtureRepo();
  const treeId = opts?.treeId ?? "test-tree";
  db.treeUpsert({
    id: treeId,
    name: treeId,
    path: repoPath,
    github: opts?.github,
    branch_prefix: "grove/",
    config: JSON.stringify({ quality_gates: { commits: true, tests: false, lint: false, diff_size: true } }),
  });
  return { db, repoPath, treeId };
}

/** Create a task in the DB in a given state. Returns the task ID. */
export function createFixtureTask(
  db: Database,
  treeId: string,
  opts?: { status?: string; title?: string; pathName?: string; worktreePath?: string; branch?: string },
): string {
  const taskId = db.nextTaskId("W");
  const status = opts?.status ?? "draft";
  const title = opts?.title ?? "Test task";
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, path_name, worktree_path, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [taskId, treeId, title, status, opts?.pathName ?? "development", opts?.worktreePath ?? null, opts?.branch ?? null],
  );
  return taskId;
}

/** Remove a temp directory (best-effort) */
export function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/helpers.ts
git commit -m "test: (#27) add test fixture helpers — db, repo, tree, task factories"
```

### Task 5: Evaluator gate unit tests

**Files:**
- Create: `tests/agents/evaluator-gates.test.ts`

- [ ] **Step 1: Write evaluator gate tests**

```typescript
// tests/agents/evaluator-gates.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { evaluate, buildRetryPrompt } from "../../src/agents/evaluator";
import { createFixtureTree, createFixtureTask, cleanupDir } from "../fixtures/helpers";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../src/broker/db";
import type { Task, Tree } from "../../src/shared/types";

let db: Database;
let repoPath: string;
let treeId: string;

beforeEach(() => {
  const fixture = createFixtureTree();
  db = fixture.db;
  repoPath = fixture.repoPath;
  treeId = fixture.treeId;
});

afterEach(() => {
  db.close();
  cleanupDir(repoPath);
});

/** Create a worktree with a commit for testing */
function setupWorktree(taskId: string): string {
  const branch = `grove/${taskId}-test`;
  const wtPath = join(repoPath, ".grove", "worktrees", taskId);
  Bun.spawnSync(["mkdir", "-p", join(repoPath, ".grove", "worktrees")]);
  Bun.spawnSync(["git", "-C", repoPath, "worktree", "add", "-b", branch, wtPath, "HEAD"]);
  return wtPath;
}

describe("evaluate — commits gate", () => {
  test("fails when no commits on branch", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(taskId);
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, `grove/${taskId}-test`, taskId]);

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    // Should fail — no commits beyond the branch point
    const commitGate = result.gateResults.find(g => g.gate === "commits");
    expect(commitGate).toBeDefined();
    expect(commitGate!.passed).toBe(false);
    expect(commitGate!.tier).toBe("hard");
    expect(result.passed).toBe(false);
  });

  test("passes when commits exist", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(taskId);
    writeFileSync(join(wtPath, "new-file.txt"), "hello");
    Bun.spawnSync(["git", "-C", wtPath, "add", "."]);
    Bun.spawnSync(["git", "-C", wtPath, "commit", "-m", "feat: add new file"]);
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, `grove/${taskId}-test`, taskId]);

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    const commitGate = result.gateResults.find(g => g.gate === "commits");
    expect(commitGate).toBeDefined();
    expect(commitGate!.passed).toBe(true);
  });
});

describe("evaluate — diff_size gate", () => {
  test("passes within default bounds", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active" });
    const wtPath = setupWorktree(taskId);
    writeFileSync(join(wtPath, "change.txt"), "a small change\n");
    Bun.spawnSync(["git", "-C", wtPath, "add", "."]);
    Bun.spawnSync(["git", "-C", wtPath, "commit", "-m", "feat: small change"]);
    db.run("UPDATE tasks SET worktree_path = ?, branch = ? WHERE id = ?", [wtPath, `grove/${taskId}-test`, taskId]);

    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    const diffGate = result.gateResults.find(g => g.gate === "diff_size");
    expect(diffGate).toBeDefined();
    expect(diffGate!.passed).toBe(true);
    expect(diffGate!.tier).toBe("soft");
  });
});

describe("evaluate — worktree missing", () => {
  test("fails when worktree path does not exist", () => {
    const taskId = createFixtureTask(db, treeId, { status: "active", worktreePath: "/nonexistent/path" });
    const task = db.taskGet(taskId)!;
    const tree = db.treeGet(treeId)!;
    const result = evaluate(task, tree, db);

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Worktree not found");
  });
});

describe("buildRetryPrompt", () => {
  test("includes failure details", () => {
    const gates = [
      { gate: "tests", passed: false, tier: "hard" as const, message: "Tests failed (exit 1)", output: "FAIL: auth.test.ts" },
      { gate: "commits", passed: true, tier: "hard" as const, message: "2 commits" },
    ];
    const prompt = buildRetryPrompt(gates);
    expect(prompt).toContain("tests: FAILED");
    expect(prompt).toContain("FAIL: auth.test.ts");
    expect(prompt).not.toContain("commits: FAILED");
  });

  test("includes seed spec when provided", () => {
    const gates = [
      { gate: "tests", passed: false, tier: "hard" as const, message: "Tests failed" },
    ];
    const prompt = buildRetryPrompt(gates, "Use the FooBar pattern");
    expect(prompt).toContain("Seed (Design Spec)");
    expect(prompt).toContain("FooBar pattern");
  });

  test("returns empty for all-passing gates", () => {
    const gates = [
      { gate: "commits", passed: true, tier: "hard" as const, message: "1 commit" },
    ];
    expect(buildRetryPrompt(gates)).toBe("");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: ALL PASS

Note: The evaluator's gate functions (`checkCommits`, `checkTests`, `checkLint`, `checkDiffSize`) are module-private. We test them indirectly via the public `evaluate()` function using real git repos.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/evaluator-gates.test.ts
git commit -m "test: (#27) evaluator gate unit tests — commits, diff_size, missing worktree, retry prompt"
```

### Task 6: Step engine unit tests

**Files:**
- Create: `tests/engine/step-engine.test.ts`

- [ ] **Step 1: Write step engine tests**

```typescript
// tests/engine/step-engine.test.ts
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb, cleanupDir } from "../fixtures/helpers";
import { normalizeAllPaths } from "../../src/engine/normalize";
import { DEFAULT_PATHS } from "../../src/shared/types";
import type { Database } from "../../src/broker/db";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("normalizeAllPaths", () => {
  test("normalizes default development path", () => {
    const paths = normalizeAllPaths(DEFAULT_PATHS);
    const dev = paths.development;
    expect(dev).toBeDefined();
    expect(dev.steps.length).toBe(4); // plan, implement, evaluate, merge
    expect(dev.steps[0].id).toBe("plan");
    expect(dev.steps[0].type).toBe("worker");
    expect(dev.steps[0].on_success).toBe("implement");
    expect(dev.steps[1].id).toBe("implement");
    expect(dev.steps[1].on_success).toBe("evaluate");
    expect(dev.steps[2].id).toBe("evaluate");
    expect(dev.steps[2].type).toBe("gate");
    expect(dev.steps[2].on_failure).toBe("implement"); // retry on gate fail
    expect(dev.steps[3].id).toBe("merge");
    expect(dev.steps[3].on_success).toBe("$done");
  });

  test("normalizes research path (no gate)", () => {
    const paths = normalizeAllPaths(DEFAULT_PATHS);
    const research = paths.research;
    expect(research.steps.length).toBe(3); // plan, research, report
    expect(research.steps[2].on_success).toBe("$done");
  });

  test("infers gate type for 'evaluate' step", () => {
    const paths = normalizeAllPaths({
      custom: { description: "test", steps: ["plan", "evaluate", "merge"] },
    });
    expect(paths.custom.steps[1].type).toBe("gate");
    expect(paths.custom.steps[2].type).toBe("merge");
  });

  test("uses $fail as default on_failure", () => {
    const paths = normalizeAllPaths({
      simple: { description: "test", steps: ["implement"] },
    });
    expect(paths.simple.steps[0].on_failure).toBe("$fail");
  });
});

describe("step engine transitions (via DB state)", () => {
  test("task stores current_step and step_index", () => {
    db.treeUpsert({ id: "test", name: "test", path: "/tmp/test" });
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, path_name, current_step, step_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["W-001", "test", "Test", "active", "development", "implement", 1],
    );
    const task = db.taskGet("W-001");
    expect(task!.current_step).toBe("implement");
    expect(task!.step_index).toBe(1);
  });

  test("retry_count increments correctly", () => {
    db.run("INSERT INTO tasks (id, title, retry_count, max_retries) VALUES (?, ?, ?, ?)", ["W-001", "Test", 0, 2]);
    db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", ["W-001"]);
    const task = db.taskGet("W-001");
    expect(task!.retry_count).toBe(1);
  });

  test("$done transition marks task completed", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Test", "active"]);
    db.run("UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?", ["W-001"]);
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("completed");
    expect(task!.current_step).toBe("$done");
    expect(task!.completed_at).not.toBeNull();
  });

  test("$fail transition marks task failed", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Test", "active"]);
    db.run("UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?", ["W-001"]);
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("failed");
    expect(task!.current_step).toBe("$fail");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/engine/step-engine.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/engine/step-engine.test.ts
git commit -m "test: (#27) step engine tests — path normalization, transitions, retry state"
```

### Task 7: Dispatch unit tests

**Files:**
- Create: `tests/broker/dispatch.test.ts`

- [ ] **Step 1: Write dispatch tests**

```typescript
// tests/broker/dispatch.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.treeUpsert({ id: "test", name: "test", path: "/tmp/test" });
});

afterEach(() => {
  db.close();
});

describe("dispatch — dependency checks", () => {
  test("task is blocked when dependency is not completed", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "test", "First", "active"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)", ["W-002", "test", "Second", "queued", "W-001"]);
    expect(db.isTaskBlocked("W-002")).toBe(true);
  });

  test("task is unblocked when dependency completes", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "test", "First", "completed"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)", ["W-002", "test", "Second", "queued", "W-001"]);
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("getNewlyUnblocked finds dependent tasks", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "test", "First", "completed"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)", ["W-002", "test", "Second", "queued", "W-001"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)", ["W-003", "test", "Third", "queued", "W-001"]);
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(2);
  });
});

describe("dispatch — task filtering", () => {
  test("tasks without tree_id are not dispatchable", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "No tree", "queued"]);
    const task = db.taskGet("W-001");
    expect(task!.tree_id).toBeNull();
  });

  test("tasks not in queued status are skipped", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "test", "Active", "active"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-002", "test", "Draft", "draft"]);
    expect(db.tasksByStatus("queued").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/broker/dispatch.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/broker/dispatch.test.ts
git commit -m "test: (#27) dispatch tests — dependencies, blocking, task filtering"
```

### Task 8: Cost monitor unit tests

**Files:**
- Create: `tests/monitor/cost.test.ts`

- [ ] **Step 1: Write cost monitor tests**

```typescript
// tests/monitor/cost.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { checkTaskBudget } from "../../src/monitor/cost";
import type { Database } from "../../src/broker/db";
import type { BudgetConfig } from "../../src/shared/types";

const budgets: BudgetConfig = {
  per_task: 5.0,
  per_session: 10.0,
  per_day: 25.0,
  per_week: 100.0,
  auto_approve_under: 2.0,
};

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

describe("checkTaskBudget", () => {
  test("ok when task cost below limit", () => {
    db.run("INSERT INTO tasks (id, title, cost_usd) VALUES (?, ?, ?)", ["W-001", "Test", 2.50]);
    const result = checkTaskBudget("W-001", db, budgets);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(2.50);
    expect(result.limit).toBe(5.0);
  });

  test("not ok when task cost exceeds limit", () => {
    db.run("INSERT INTO tasks (id, title, cost_usd) VALUES (?, ?, ?)", ["W-001", "Test", 6.00]);
    const result = checkTaskBudget("W-001", db, budgets);
    expect(result.ok).toBe(false);
  });

  test("handles missing task gracefully", () => {
    const result = checkTaskBudget("W-999", db, budgets);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(0);
  });
});

describe("daily cost tracking", () => {
  test("costToday sums current day sessions", () => {
    db.sessionCreate("s-001", null, "worker");
    db.sessionUpdateCost("s-001", 3.00, 1000);
    db.sessionCreate("s-002", null, "worker");
    db.sessionUpdateCost("s-002", 4.50, 2000);
    expect(db.costToday()).toBe(7.50);
  });

  test("costWeek sums current week sessions", () => {
    db.sessionCreate("s-001", null, "worker");
    db.sessionUpdateCost("s-001", 10.00, 5000);
    expect(db.costWeek()).toBeGreaterThanOrEqual(10.0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/monitor/cost.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/monitor/cost.test.ts
git commit -m "test: (#27) cost monitor tests — per-task budget, daily/weekly aggregation"
```

### Task 9: Stream parser unit tests

**Files:**
- Create: `tests/agents/stream-parser.test.ts`

- [ ] **Step 1: Write stream parser tests**

```typescript
// tests/agents/stream-parser.test.ts
import { describe, test, expect } from "bun:test";
import { parseCost, lastActivity, formatStreamLine, parseBrokerEvent, isAlive } from "../../src/agents/stream-parser";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseCost", () => {
  test("extracts cost from result line", () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-sp-"));
    const logFile = join(dir, "test.jsonl");
    writeFileSync(logFile, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","cost_usd":1.23,"usage":{"input_tokens":500,"output_tokens":200}}',
    ].join("\n"));

    const cost = parseCost(logFile);
    expect(cost.costUsd).toBe(1.23);
    expect(cost.inputTokens).toBe(500);
    expect(cost.outputTokens).toBe(200);
  });

  test("returns zeros for non-existent file", () => {
    const cost = parseCost("/nonexistent/file.jsonl");
    expect(cost.costUsd).toBe(0);
    expect(cost.inputTokens).toBe(0);
  });

  test("handles empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-sp-"));
    const logFile = join(dir, "empty.jsonl");
    writeFileSync(logFile, "");
    const cost = parseCost(logFile);
    expect(cost.costUsd).toBe(0);
  });
});

describe("formatStreamLine", () => {
  test("formats assistant text", () => {
    const result = formatStreamLine('{"type":"assistant","text":"Hello world"}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("Hello world");
  });

  test("formats tool_use", () => {
    const result = formatStreamLine('{"type":"tool_use","name":"Read","input":{"file_path":"/src/main.ts"}}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_use");
    expect(result!.text).toContain("Read");
    expect(result!.text).toContain("/src/main.ts");
  });

  test("formats result with cost", () => {
    const result = formatStreamLine('{"type":"result","cost_usd":0.42}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe("result");
    expect(result!.text).toContain("$0.42");
  });

  test("returns null for empty input", () => {
    expect(formatStreamLine("")).toBeNull();
    expect(formatStreamLine("   ")).toBeNull();
  });
});

describe("parseBrokerEvent", () => {
  test("parses valid broker event", () => {
    const event = parseBrokerEvent('{"type":"spawn_worker","tree":"api","task":"W-001","prompt":"fix"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe("spawn_worker");
  });

  test("returns null for non-event JSON", () => {
    expect(parseBrokerEvent('{"foo":"bar"}')).toBeNull();
  });

  test("returns null for non-JSON", () => {
    expect(parseBrokerEvent("not json")).toBeNull();
  });
});

describe("isAlive", () => {
  test("returns true for current process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("returns false for null/undefined/zero", () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });

  test("returns false for non-existent PID", () => {
    expect(isAlive(999999999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/agents/stream-parser.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agents/stream-parser.test.ts
git commit -m "test: (#27) stream parser tests — cost parsing, line formatting, broker events, PID liveness"
```

### Task 10: CI workflow for tests

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create test workflow**

```yaml
# .github/workflows/test.yml
name: Tests
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun test
```

- [ ] **Step 2: Run tests locally to verify**

Run: `bun test`
Expected: ALL PASS — all existing + new tests

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: (#27) add GitHub Actions test workflow — runs bun test on push and PR"
```

---

## Phase 3: Notification System (Issue #24)

### Task 11: Notification dispatcher and channel interfaces

**Files:**
- Create: `src/notifications/types.ts`
- Create: `src/notifications/dispatcher.ts`
- Test: `tests/notifications/dispatcher.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/notifications/dispatcher.test.ts
import { describe, test, expect } from "bun:test";
import { buildNotification, shouldNotify } from "../../src/notifications/dispatcher";

describe("buildNotification", () => {
  test("builds notification for task_failed event", () => {
    const n = buildNotification("task_failed", {
      taskId: "W-001",
      title: "Fix auth bug",
      feedback: "Tests failed (exit 1)",
    });
    expect(n.event).toBe("task_failed");
    expect(n.severity).toBe("error");
    expect(n.title).toContain("W-001");
    expect(n.body).toContain("Tests failed");
  });

  test("builds notification for pr_merged event", () => {
    const n = buildNotification("pr_merged", {
      taskId: "W-001",
      title: "Fix auth bug",
      prNumber: 42,
    });
    expect(n.event).toBe("pr_merged");
    expect(n.severity).toBe("info");
    expect(n.body).toContain("#42");
  });
});

describe("shouldNotify", () => {
  test("returns true when event is in routes", () => {
    const routes = { task_failed: ["slack"], pr_merged: ["slack"] };
    expect(shouldNotify("task_failed", routes)).toBe(true);
  });

  test("returns false when event is not in routes", () => {
    const routes = { task_failed: ["slack"] };
    expect(shouldNotify("task_completed", routes)).toBe(false);
  });

  test("returns false for empty routes", () => {
    expect(shouldNotify("task_failed", {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/notifications/dispatcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement types and dispatcher**

```typescript
// src/notifications/types.ts
export interface Notification {
  event: string;
  title: string;
  body: string;
  taskId?: string;
  severity: "info" | "warning" | "error";
  url?: string;
}

export interface NotificationChannel {
  name: string;
  send(notification: Notification): Promise<void>;
}

export interface NotificationRoutes {
  [eventType: string]: string[]; // event -> channel names
}

export interface NotificationConfig {
  channels?: {
    slack?: { webhook_url?: string; env?: string };
    system?: { enabled?: boolean };
    webhook?: { url?: string; secret?: string };
  };
  routes?: NotificationRoutes;
  quiet_hours?: { start?: string; end?: string };
}
```

```typescript
// src/notifications/dispatcher.ts
import type { Notification, NotificationChannel, NotificationRoutes } from "./types";

const channels = new Map<string, NotificationChannel>();
const rateLimitMap = new Map<string, number>(); // event -> last sent timestamp
const RATE_LIMIT_MS = 60_000; // 1 notification per event type per 60 seconds

export function registerChannel(channel: NotificationChannel): void {
  channels.set(channel.name, channel);
}

export function buildNotification(
  event: string,
  ctx: { taskId?: string; title?: string; feedback?: string; prNumber?: number; current?: number; limit?: number; period?: string },
): Notification {
  const taskLabel = ctx.taskId ? `[${ctx.taskId}]` : "";

  switch (event) {
    case "task_completed":
      return { event, severity: "info", taskId: ctx.taskId, title: `${taskLabel} Task completed`, body: ctx.title ?? "Task finished successfully" };
    case "task_failed":
      return { event, severity: "error", taskId: ctx.taskId, title: `${taskLabel} Task failed`, body: ctx.feedback ?? ctx.title ?? "Task failed" };
    case "gate_failed":
      return { event, severity: "warning", taskId: ctx.taskId, title: `${taskLabel} Gate failed`, body: ctx.feedback ?? "Quality gate check failed" };
    case "pr_merged":
      return { event, severity: "info", taskId: ctx.taskId, title: `${taskLabel} PR merged`, body: `PR #${ctx.prNumber ?? "?"} merged — ${ctx.title ?? ""}` };
    case "ci_failed":
      return { event, severity: "error", taskId: ctx.taskId, title: `${taskLabel} CI failed`, body: `CI failed on PR #${ctx.prNumber ?? "?"}` };
    case "budget_warning":
      return { event, severity: "warning", title: "Budget warning", body: `${ctx.period} spend: $${ctx.current?.toFixed(2)} / $${ctx.limit?.toFixed(2)}` };
    case "budget_exceeded":
      return { event, severity: "error", title: "Budget exceeded", body: `${ctx.period} limit reached: $${ctx.current?.toFixed(2)} / $${ctx.limit?.toFixed(2)}. Spawning paused.` };
    case "orchestrator_crashed":
      return { event, severity: "error", title: "Orchestrator crashed", body: "Orchestrator process died — auto-recovering..." };
    default:
      return { event, severity: "info", taskId: ctx.taskId, title: `Grove: ${event}`, body: ctx.title ?? event };
  }
}

export function shouldNotify(event: string, routes: NotificationRoutes): boolean {
  return Array.isArray(routes[event]) && routes[event].length > 0;
}

export async function dispatch(notification: Notification, routes: NotificationRoutes): Promise<void> {
  const channelNames = routes[notification.event];
  if (!channelNames || channelNames.length === 0) return;

  // Rate limiting
  const lastSent = rateLimitMap.get(notification.event) ?? 0;
  if (Date.now() - lastSent < RATE_LIMIT_MS) return;
  rateLimitMap.set(notification.event, Date.now());

  for (const name of channelNames) {
    const channel = channels.get(name);
    if (channel) {
      try {
        await channel.send(notification);
      } catch {
        // Best-effort — don't crash the broker for a notification failure
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/notifications/dispatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifications/types.ts src/notifications/dispatcher.ts tests/notifications/dispatcher.test.ts
git commit -m "feat: (#24) notification dispatcher with rate limiting and event routing"
```

### Task 12: Slack notification channel

**Files:**
- Create: `src/notifications/channels/slack.ts`
- Test: `tests/notifications/slack.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/notifications/slack.test.ts
import { describe, test, expect } from "bun:test";
import { formatSlackPayload } from "../../src/notifications/channels/slack";

describe("formatSlackPayload", () => {
  test("formats error notification with red color", () => {
    const payload = formatSlackPayload({
      event: "task_failed",
      severity: "error",
      title: "[W-001] Task failed",
      body: "Tests failed (exit 1)",
      taskId: "W-001",
    });
    expect(payload.attachments[0].color).toBe("#B60205");
    expect(payload.attachments[0].blocks[0].text.text).toContain("Task failed");
  });

  test("formats info notification with green color", () => {
    const payload = formatSlackPayload({
      event: "pr_merged",
      severity: "info",
      title: "[W-001] PR merged",
      body: "PR #42 merged",
      taskId: "W-001",
    });
    expect(payload.attachments[0].color).toBe("#0E8A16");
  });

  test("formats warning notification with yellow color", () => {
    const payload = formatSlackPayload({
      event: "budget_warning",
      severity: "warning",
      title: "Budget warning",
      body: "daily spend: $20.00 / $25.00",
    });
    expect(payload.attachments[0].color).toBe("#FBCA04");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/notifications/slack.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Slack channel**

```typescript
// src/notifications/channels/slack.ts
import type { Notification, NotificationChannel } from "../types";

const SEVERITY_COLORS = {
  info: "#0E8A16",
  warning: "#FBCA04",
  error: "#B60205",
};

export function formatSlackPayload(notification: Notification): any {
  const color = SEVERITY_COLORS[notification.severity];
  return {
    attachments: [{
      color,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${notification.title}*\n${notification.body}` },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `*Event:* ${notification.event}${notification.taskId ? ` | *Task:* ${notification.taskId}` : ""}` },
          ],
        },
      ],
    }],
  };
}

export function createSlackChannel(webhookUrl: string): NotificationChannel {
  return {
    name: "slack",
    async send(notification: Notification): Promise<void> {
      const payload = formatSlackPayload(notification);
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/notifications/slack.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifications/channels/slack.ts tests/notifications/slack.test.ts
git commit -m "feat: (#24) Slack notification channel with Block Kit formatting"
```

### Task 13: System notification channel

**Files:**
- Create: `src/notifications/channels/system.ts`

- [ ] **Step 1: Implement system notifications**

```typescript
// src/notifications/channels/system.ts
import type { Notification, NotificationChannel } from "../types";

function isInQuietHours(start?: string, end?: string): boolean {
  if (!start || !end) return false;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const current = h * 60 + m;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  // Handle overnight quiet hours (e.g., 22:00 - 07:00)
  if (startMin > endMin) return current >= startMin || current < endMin;
  return current >= startMin && current < endMin;
}

export function createSystemChannel(quietHours?: { start?: string; end?: string }): NotificationChannel {
  return {
    name: "system",
    async send(notification: Notification): Promise<void> {
      if (isInQuietHours(quietHours?.start, quietHours?.end)) return;

      const platform = process.platform;
      if (platform === "darwin") {
        Bun.spawnSync([
          "osascript", "-e",
          `display notification "${notification.body.replace(/"/g, '\\"').slice(0, 200)}" with title "Grove" subtitle "${notification.title.replace(/"/g, '\\"').slice(0, 100)}"`,
        ]);
      } else if (platform === "linux") {
        Bun.spawnSync(["notify-send", "Grove", `${notification.title}\n${notification.body.slice(0, 200)}`]);
      }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/notifications/channels/system.ts
git commit -m "feat: (#24) system notification channel — macOS + Linux support with quiet hours"
```

### Task 14: Webhook notification channel

**Files:**
- Create: `src/notifications/channels/webhook.ts`

- [ ] **Step 1: Implement webhook channel**

```typescript
// src/notifications/channels/webhook.ts
import type { Notification, NotificationChannel } from "../types";

function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  ).then(key =>
    crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  ).then(sig =>
    Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")
  );
}

export function createWebhookChannel(url: string, secret?: string): NotificationChannel {
  return {
    name: "webhook",
    async send(notification: Notification): Promise<void> {
      const payload = JSON.stringify({
        event: notification.event,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        taskId: notification.taskId,
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (secret) {
        headers["X-Grove-Signature"] = await hmacSign(payload, secret);
      }

      const res = await fetch(url, { method: "POST", headers, body: payload });
      // Retry once on 5xx
      if (res.status >= 500) {
        await new Promise(r => setTimeout(r, 1000));
        await fetch(url, { method: "POST", headers, body: payload });
      }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/notifications/channels/webhook.ts
git commit -m "feat: (#24) webhook notification channel with HMAC-SHA256 signing"
```

### Task 15: Wire notifications into event bus and config

**Files:**
- Create: `src/notifications/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/broker/config.ts`
- Modify: `src/broker/index.ts`

- [ ] **Step 1: Add NotificationConfig to types**

In `src/shared/types.ts`, add after `SettingsConfig`:

```typescript
export interface NotificationConfig {
  channels?: {
    slack?: { webhook_url?: string; env?: string };
    system?: { enabled?: boolean };
    webhook?: { url?: string; secret?: string };
  };
  routes?: Record<string, string[]>;
  quiet_hours?: { start?: string; end?: string };
}
```

Add `notifications?: NotificationConfig;` to the `GroveConfig` interface.

- [ ] **Step 2: Update config.ts to parse notifications**

In `src/broker/config.ts`, add to the `mergeDefaults` function:

```typescript
notifications: partial.notifications,
```

Add accessor:

```typescript
export function notificationsConfig(): NotificationConfig | undefined {
  return loadConfig().notifications;
}
```

- [ ] **Step 3: Create the wiring module**

```typescript
// src/notifications/index.ts
import { bus } from "../broker/event-bus";
import { buildNotification, dispatch, registerChannel } from "./dispatcher";
import { createSlackChannel } from "./channels/slack";
import { createSystemChannel } from "./channels/system";
import { createWebhookChannel } from "./channels/webhook";
import type { NotificationConfig } from "../shared/types";

export function wireNotifications(config?: NotificationConfig): void {
  if (!config) return;

  const routes = config.routes ?? {};

  // Register channels
  if (config.channels?.slack) {
    const url = config.channels.slack.webhook_url
      ?? (config.channels.slack.env ? process.env[config.channels.slack.env] : undefined);
    if (url) registerChannel(createSlackChannel(url));
  }

  if (config.channels?.system?.enabled !== false) {
    registerChannel(createSystemChannel(config.quiet_hours));
  }

  if (config.channels?.webhook?.url) {
    registerChannel(createWebhookChannel(config.channels.webhook.url, config.channels.webhook.secret));
  }

  // Subscribe to events
  bus.on("task:status", ({ taskId, status }) => {
    if (status === "completed") {
      dispatch(buildNotification("task_completed", { taskId }), routes);
    }
    if (status === "failed") {
      dispatch(buildNotification("task_failed", { taskId }), routes);
    }
  });

  bus.on("eval:failed", ({ taskId, feedback }) => {
    dispatch(buildNotification("gate_failed", { taskId, feedback }), routes);
  });

  bus.on("merge:completed", ({ taskId, prNumber }) => {
    dispatch(buildNotification("pr_merged", { taskId, prNumber }), routes);
  });

  bus.on("merge:ci_failed", ({ taskId, prNumber }) => {
    dispatch(buildNotification("ci_failed", { taskId, prNumber }), routes);
  });

  bus.on("cost:budget_warning", ({ current, limit, period }) => {
    dispatch(buildNotification("budget_warning", { current, limit, period }), routes);
  });

  bus.on("cost:budget_exceeded", ({ current, limit, period }) => {
    dispatch(buildNotification("budget_exceeded", { current, limit, period }), routes);
  });

  bus.on("monitor:crash", ({ taskId }) => {
    dispatch(buildNotification("orchestrator_crashed", { taskId }), routes);
  });
}
```

- [ ] **Step 4: Wire into broker startup**

In `src/broker/index.ts`, add after the `startCostMonitor` call:

```typescript
import { wireNotifications } from "../notifications";
// ...
// Wire notifications (after config load)
const { notificationsConfig } = await import("./config");
wireNotifications(notificationsConfig());
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/notifications/index.ts src/shared/types.ts src/broker/config.ts src/broker/index.ts
git commit -m "feat: (#24) wire notification system into event bus and broker startup"
```

---

## Phase 4: Analytics Dashboard (Issue #25)

### Task 16: Analytics API endpoints

**Files:**
- Modify: `src/broker/db.ts` (add analytics query methods)
- Modify: `src/broker/server.ts` (add /api/analytics/* endpoints)
- Test: `tests/broker/analytics.test.ts`

- [ ] **Step 1: Write failing test for analytics DB queries**

```typescript
// tests/broker/analytics.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.treeUpsert({ id: "api", name: "api", path: "/code/api" });
  db.treeUpsert({ id: "web", name: "web", path: "/code/web" });
});

afterEach(() => {
  db.close();
});

describe("costByTree", () => {
  test("returns cost breakdown per tree", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-001", "api", "T1", 2.50]);
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-002", "api", "T2", 1.50]);
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-003", "web", "T3", 3.00]);
    const result = db.costByTree();
    expect(result.find(r => r.tree_id === "api")!.total_cost).toBe(4.0);
    expect(result.find(r => r.tree_id === "web")!.total_cost).toBe(3.0);
  });
});

describe("gateAnalytics", () => {
  test("counts pass/fail per gate type", () => {
    const gates1 = JSON.stringify([
      { gate: "commits", passed: true, tier: "hard", message: "1 commit" },
      { gate: "tests", passed: false, tier: "hard", message: "fail" },
    ]);
    const gates2 = JSON.stringify([
      { gate: "commits", passed: true, tier: "hard", message: "2 commits" },
      { gate: "tests", passed: true, tier: "hard", message: "pass" },
    ]);
    db.run("INSERT INTO tasks (id, title, gate_results) VALUES (?, ?, ?)", ["W-001", "T1", gates1]);
    db.run("INSERT INTO tasks (id, title, gate_results) VALUES (?, ?, ?)", ["W-002", "T2", gates2]);
    const result = db.gateAnalytics();
    expect(result.find(r => r.gate === "commits")!.passed).toBe(2);
    expect(result.find(r => r.gate === "tests")!.passed).toBe(1);
    expect(result.find(r => r.gate === "tests")!.failed).toBe(1);
  });
});

describe("taskTimeline", () => {
  test("returns tasks with timestamps", () => {
    db.run("INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, ?, datetime('now'))", ["W-001", "T1", "completed"]);
    const timeline = db.taskTimeline(24);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0].id).toBe("W-001");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/analytics.test.ts`
Expected: FAIL — methods not defined

- [ ] **Step 3: Add analytics methods to db.ts**

Add these methods to the `Database` class in `src/broker/db.ts`:

```typescript
/** Cost per tree (for analytics dashboard) */
costByTree(): Array<{ tree_id: string; total_cost: number; task_count: number }> {
  return this.all(
    `SELECT tree_id, SUM(cost_usd) as total_cost, COUNT(*) as task_count
     FROM tasks WHERE tree_id IS NOT NULL
     GROUP BY tree_id ORDER BY total_cost DESC`
  );
}

/** Gate pass/fail analytics */
gateAnalytics(): Array<{ gate: string; passed: number; failed: number; total: number }> {
  const tasks = this.all<{ gate_results: string }>(
    "SELECT gate_results FROM tasks WHERE gate_results IS NOT NULL"
  );
  const stats = new Map<string, { passed: number; failed: number }>();
  for (const t of tasks) {
    try {
      const gates = JSON.parse(t.gate_results) as Array<{ gate: string; passed: boolean }>;
      for (const g of gates) {
        const s = stats.get(g.gate) ?? { passed: 0, failed: 0 };
        if (g.passed) s.passed++; else s.failed++;
        stats.set(g.gate, s);
      }
    } catch {}
  }
  return Array.from(stats.entries()).map(([gate, s]) => ({
    gate, passed: s.passed, failed: s.failed, total: s.passed + s.failed,
  }));
}

/** Tasks within a time window for timeline view */
taskTimeline(hoursBack: number = 24): Array<Task> {
  return this.all(
    `SELECT * FROM tasks WHERE created_at > datetime('now', '-${hoursBack} hours') ORDER BY created_at ASC`
  );
}

/** Daily cost for the last N days */
costDaily(days: number = 30): Array<{ date: string; total: number }> {
  return this.all(
    `SELECT DATE(started_at) as date, SUM(cost_usd) as total
     FROM sessions WHERE started_at > datetime('now', '-${days} days')
     GROUP BY DATE(started_at) ORDER BY date ASC`
  );
}

/** Top N most expensive tasks */
costTopTasks(limit: number = 10): Array<{ id: string; title: string; cost_usd: number; tree_id: string }> {
  return this.all(
    "SELECT id, title, cost_usd, tree_id FROM tasks ORDER BY cost_usd DESC LIMIT ?",
    [limit]
  );
}

/** Retry statistics */
retryStats(): { total_tasks: number; retried_tasks: number; avg_retries: number } {
  const row = this.get<{ total: number; retried: number; avg_retries: number }>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried,
            COALESCE(AVG(CASE WHEN retry_count > 0 THEN retry_count END), 0) as avg_retries
     FROM tasks`
  );
  return {
    total_tasks: row?.total ?? 0,
    retried_tasks: row?.retried ?? 0,
    avg_retries: row?.avg_retries ?? 0,
  };
}
```

- [ ] **Step 4: Add analytics API endpoints to server.ts**

In `src/broker/server.ts`, add before the final `return json({ error: "Not found" }, 404);`:

```typescript
// GET /api/analytics/cost
if (path === "/api/analytics/cost" && req.method === "GET") {
  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  return json({
    today: db.costToday(),
    week: db.costWeek(),
    daily: db.costDaily(days),
    by_tree: db.costByTree(),
    top_tasks: db.costTopTasks(),
  });
}

// GET /api/analytics/gates
if (path === "/api/analytics/gates" && req.method === "GET") {
  return json({
    by_gate: db.gateAnalytics(),
    retry_stats: db.retryStats(),
  });
}

// GET /api/analytics/timeline
if (path === "/api/analytics/timeline" && req.method === "GET") {
  const url = new URL(req.url);
  const hours = parseInt(url.searchParams.get("hours") ?? "24", 10);
  const tasks = db.taskTimeline(hours);
  // Annotate with sessions
  const annotated = tasks.map(t => ({
    ...t,
    sessions: db.all(
      "SELECT id, role, started_at, ended_at, cost_usd, status FROM sessions WHERE task_id = ? ORDER BY started_at",
      [t.id]
    ),
  }));
  return json(annotated);
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/broker/analytics.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/broker/db.ts src/broker/server.ts tests/broker/analytics.test.ts
git commit -m "feat: (#25) analytics API — cost breakdown, gate stats, timeline endpoints"
```

### Task 17: Dashboard React component

**Files:**
- Create: `web/src/components/Dashboard.tsx`
- Create: `web/src/hooks/useAnalytics.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Sidebar.tsx`

- [ ] **Step 1: Create analytics data hook**

```typescript
// web/src/hooks/useAnalytics.ts
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api/client";

export interface CostAnalytics {
  today: number;
  week: number;
  daily: Array<{ date: string; total: number }>;
  by_tree: Array<{ tree_id: string; total_cost: number; task_count: number }>;
  top_tasks: Array<{ id: string; title: string; cost_usd: number; tree_id: string }>;
}

export interface GateAnalytics {
  by_gate: Array<{ gate: string; passed: number; failed: number; total: number }>;
  retry_stats: { total_tasks: number; retried_tasks: number; avg_retries: number };
}

export interface TimelineTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number;
  tree_id: string | null;
  sessions: Array<{ id: string; role: string; started_at: string; ended_at: string | null; cost_usd: number; status: string }>;
}

export function useAnalytics() {
  const [cost, setCost] = useState<CostAnalytics | null>(null);
  const [gates, setGates] = useState<GateAnalytics | null>(null);
  const [timeline, setTimeline] = useState<TimelineTask[]>([]);
  const [timeRange, setTimeRange] = useState(24); // hours
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [costData, gateData, timelineData] = await Promise.all([
        apiFetch("/api/analytics/cost"),
        apiFetch("/api/analytics/gates"),
        apiFetch(`/api/analytics/timeline?hours=${timeRange}`),
      ]);
      setCost(costData);
      setGates(gateData);
      setTimeline(timelineData);
    } catch {}
    setLoading(false);
  }, [timeRange]);

  useEffect(() => { refresh(); }, [refresh]);

  return { cost, gates, timeline, timeRange, setTimeRange, loading, refresh };
}
```

- [ ] **Step 2: Create the Dashboard component**

```typescript
// web/src/components/Dashboard.tsx
import { useAnalytics } from "../hooks/useAnalytics";
import type { CostAnalytics, GateAnalytics, TimelineTask } from "../hooks/useAnalytics";

export default function Dashboard() {
  const { cost, gates, timeline, timeRange, setTimeRange, loading, refresh } = useAnalytics();

  return (
    <div className="p-4 space-y-6 max-w-full overflow-x-hidden">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Dashboard</h1>
        <button onClick={refresh} className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded border border-zinc-700">
          Refresh
        </button>
      </div>

      {loading && <p className="text-zinc-500 text-sm">Loading analytics...</p>}

      {/* KPI Cards */}
      {cost && <KpiCards cost={cost} />}

      {/* Timeline */}
      <TimelineSection timeline={timeline} timeRange={timeRange} onTimeRangeChange={setTimeRange} />

      {/* Cost Charts */}
      {cost && <CostSection cost={cost} />}

      {/* Gate Analytics */}
      {gates && <GateSection gates={gates} />}
    </div>
  );
}

function KpiCards({ cost }: { cost: CostAnalytics }) {
  const cards = [
    { label: "Today", value: `$${cost.today.toFixed(2)}` },
    { label: "This Week", value: `$${cost.week.toFixed(2)}` },
    { label: "Trees", value: String(cost.by_tree.length) },
    { label: "Tasks Tracked", value: String(cost.top_tasks.length) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
          <div className="text-xs text-zinc-500 uppercase tracking-wider">{c.label}</div>
          <div className="text-xl font-semibold text-zinc-100 mt-1">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function TimelineSection({ timeline, timeRange, onTimeRangeChange }: {
  timeline: TimelineTask[];
  timeRange: number;
  onTimeRangeChange: (h: number) => void;
}) {
  const ranges = [1, 4, 24, 168]; // 1h, 4h, 24h, 7d
  const labels = ["1h", "4h", "24h", "7d"];

  if (timeline.length === 0) {
    return (
      <div className="bg-zinc-800/30 rounded-lg p-4 border border-zinc-700/50">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-zinc-300">Timeline</h2>
          <TimeRangeButtons ranges={ranges} labels={labels} current={timeRange} onChange={onTimeRangeChange} />
        </div>
        <p className="text-zinc-500 text-sm">No tasks in this time range.</p>
      </div>
    );
  }

  const now = Date.now();
  const startMs = now - timeRange * 3600_000;
  const totalMs = now - startMs;

  return (
    <div className="bg-zinc-800/30 rounded-lg p-4 border border-zinc-700/50">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-zinc-300">Timeline</h2>
        <TimeRangeButtons ranges={ranges} labels={labels} current={timeRange} onChange={onTimeRangeChange} />
      </div>
      <div className="space-y-1.5">
        {timeline.map(task => {
          const created = new Date(task.created_at).getTime();
          const ended = task.completed_at ? new Date(task.completed_at).getTime() : now;
          const leftPct = Math.max(0, ((created - startMs) / totalMs) * 100);
          const widthPct = Math.max(2, ((ended - created) / totalMs) * 100);
          const color = task.status === "completed" ? "bg-emerald-500/70"
            : task.status === "failed" ? "bg-red-500/70"
            : task.status === "active" ? "bg-blue-500/70"
            : "bg-zinc-600/70";

          return (
            <div key={task.id} className="flex items-center gap-2 text-xs">
              <span className="w-14 text-zinc-500 shrink-0 text-right">{task.id}</span>
              <div className="flex-1 relative h-5 bg-zinc-900/50 rounded overflow-hidden">
                <div
                  className={`absolute top-0 h-full rounded ${color}`}
                  style={{ left: `${leftPct}%`, width: `${Math.min(widthPct, 100 - leftPct)}%` }}
                  title={`${task.title} — ${task.status} — $${task.cost_usd.toFixed(2)}`}
                />
              </div>
              <span className="w-20 text-zinc-500 shrink-0 truncate">{task.title.slice(0, 20)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeRangeButtons({ ranges, labels, current, onChange }: {
  ranges: number[]; labels: string[]; current: number; onChange: (h: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {ranges.map((r, i) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2 py-0.5 text-xs rounded ${
            current === r ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );
}

function CostSection({ cost }: { cost: CostAnalytics }) {
  const maxCost = Math.max(...cost.by_tree.map(t => t.total_cost), 0.01);
  return (
    <div className="bg-zinc-800/30 rounded-lg p-4 border border-zinc-700/50">
      <h2 className="text-sm font-medium text-zinc-300 mb-3">Cost by Tree</h2>
      <div className="space-y-2">
        {cost.by_tree.map(t => (
          <div key={t.tree_id} className="flex items-center gap-2 text-xs">
            <span className="w-24 text-zinc-400 shrink-0 truncate">{t.tree_id}</span>
            <div className="flex-1 bg-zinc-900/50 rounded h-4 overflow-hidden">
              <div
                className="h-full bg-emerald-500/50 rounded"
                style={{ width: `${(t.total_cost / maxCost) * 100}%` }}
              />
            </div>
            <span className="w-16 text-zinc-500 text-right">${t.total_cost.toFixed(2)}</span>
          </div>
        ))}
      </div>
      {cost.top_tasks.length > 0 && (
        <>
          <h3 className="text-xs text-zinc-400 mt-4 mb-2">Top Tasks by Cost</h3>
          <div className="space-y-1">
            {cost.top_tasks.slice(0, 5).map(t => (
              <div key={t.id} className="flex justify-between text-xs">
                <span className="text-zinc-400">{t.id} {t.title.slice(0, 40)}</span>
                <span className="text-zinc-500">${t.cost_usd.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GateSection({ gates }: { gates: GateAnalytics }) {
  return (
    <div className="bg-zinc-800/30 rounded-lg p-4 border border-zinc-700/50">
      <h2 className="text-sm font-medium text-zinc-300 mb-3">Quality Gates</h2>
      <div className="space-y-2">
        {gates.by_gate.map(g => {
          const passRate = g.total > 0 ? Math.round((g.passed / g.total) * 100) : 0;
          return (
            <div key={g.gate} className="flex items-center gap-2 text-xs">
              <span className="w-20 text-zinc-400 shrink-0">{g.gate}</span>
              <div className="flex-1 bg-zinc-900/50 rounded h-4 overflow-hidden flex">
                <div className="h-full bg-emerald-500/50" style={{ width: `${passRate}%` }} />
                <div className="h-full bg-red-500/50" style={{ width: `${100 - passRate}%` }} />
              </div>
              <span className="w-24 text-zinc-500 text-right">{g.passed}/{g.total} ({passRate}%)</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 text-xs text-zinc-500">
        Retry rate: {gates.retry_stats.retried_tasks}/{gates.retry_stats.total_tasks} tasks
        ({gates.retry_stats.total_tasks > 0 ? Math.round((gates.retry_stats.retried_tasks / gates.retry_stats.total_tasks) * 100) : 0}%)
        {gates.retry_stats.avg_retries > 0 && ` — avg ${gates.retry_stats.avg_retries.toFixed(1)} retries`}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add Dashboard route to App.tsx**

In `web/src/App.tsx`:

Add import: `import Dashboard from "./components/Dashboard";`

Change `type View` to: `type View = "tasks" | "settings" | "dashboard";`

Add dashboard case in the center panel (both mobile and desktop render paths), next to the tasks/settings conditional:

```tsx
// In the center panel render:
view === "tasks" ? (
  <TaskList ... />
) : view === "dashboard" ? (
  <Dashboard />
) : (
  <Settings ... />
)
```

- [ ] **Step 4: Add Dashboard nav to Sidebar**

In `web/src/components/Sidebar.tsx`, add a dashboard button near the settings button:

Add `onDashboardClick` to the Sidebar props and render a button labeled "Dashboard" that calls it.

In `App.tsx`, pass `onDashboardClick={() => setView("dashboard")}` to `<Sidebar>`.

- [ ] **Step 5: Build web and verify**

Run: `cd web && bun run build && cd ..`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Dashboard.tsx web/src/hooks/useAnalytics.ts web/src/App.tsx web/src/components/Sidebar.tsx
git commit -m "feat: (#25) analytics dashboard — timeline, cost charts, gate analytics"
```

---

## Phase 5: Binary Distribution (Issue #26)

### Task 18: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create release workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-14
            target: bun-darwin-arm64
            artifact: grove-darwin-arm64
          - os: macos-13
            target: bun-darwin-x64
            artifact: grove-darwin-x64
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: grove-linux-x64

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build web
        run: bun run build:web

      - name: Embed web assets
        run: bun run build:embed

      - name: Compile binary
        run: |
          mkdir -p bin
          bun build src/cli/index.ts --compile --target=${{ matrix.target }} --outfile bin/${{ matrix.artifact }}

      - name: Compress
        run: tar -czf ${{ matrix.artifact }}.tar.gz -C bin ${{ matrix.artifact }}

      - name: Checksum
        run: shasum -a 256 ${{ matrix.artifact }}.tar.gz > ${{ matrix.artifact }}.tar.gz.sha256

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: |
            ${{ matrix.artifact }}.tar.gz
            ${{ matrix.artifact }}.tar.gz.sha256

  release:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Download all artifacts
        uses: actions/download-artifact@v4

      - name: Generate changelog
        id: changelog
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
          if [ -n "$PREV_TAG" ]; then
            echo "CHANGELOG<<EOF" >> $GITHUB_OUTPUT
            git log --format="- %s" ${PREV_TAG}..HEAD >> $GITHUB_OUTPUT
            echo "EOF" >> $GITHUB_OUTPUT
          else
            echo "CHANGELOG=Initial release" >> $GITHUB_OUTPUT
          fi

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          body: |
            ## Changes
            ${{ steps.changelog.outputs.CHANGELOG }}

            ## Installation
            ```bash
            # macOS (Apple Silicon)
            curl -fsSL https://github.com/bpamiri/grove/releases/download/${{ github.ref_name }}/grove-darwin-arm64.tar.gz | tar xz -C /usr/local/bin

            # macOS (Intel)
            curl -fsSL https://github.com/bpamiri/grove/releases/download/${{ github.ref_name }}/grove-darwin-x64.tar.gz | tar xz -C /usr/local/bin

            # Linux
            curl -fsSL https://github.com/bpamiri/grove/releases/download/${{ github.ref_name }}/grove-linux-x64.tar.gz | tar xz -C /usr/local/bin
            ```
          files: |
            grove-darwin-arm64/grove-darwin-arm64.tar.gz
            grove-darwin-arm64/grove-darwin-arm64.tar.gz.sha256
            grove-darwin-x64/grove-darwin-x64.tar.gz
            grove-darwin-x64/grove-darwin-x64.tar.gz.sha256
            grove-linux-x64/grove-linux-x64.tar.gz
            grove-linux-x64/grove-linux-x64.tar.gz.sha256
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: (#26) multi-platform release workflow — macOS arm64/x64, Linux x64"
```

### Task 19: Install script

**Files:**
- Create: `scripts/install.sh`

- [ ] **Step 1: Create install script**

```bash
#!/bin/bash
# Grove installer — detects platform, downloads latest release binary
set -euo pipefail

REPO="bpamiri/grove"
INSTALL_DIR="${GROVE_INSTALL_DIR:-/usr/local/bin}"

echo "Installing Grove..."

# Get latest version
VERSION=$(curl -sS "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "Error: Could not determine latest version." >&2
  exit 1
fi
echo "  Version: $VERSION"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "Error: Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
echo "  Platform: $OS/$ARCH"

BINARY="grove-${OS}-${ARCH}"
URL="https://github.com/$REPO/releases/download/$VERSION/${BINARY}.tar.gz"

# Download and install
echo "  Downloading $URL..."
curl -fsSL "$URL" | tar xz -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/grove"

echo ""
echo "Grove $VERSION installed to $INSTALL_DIR/grove"
echo "Run 'grove init' to get started."
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/install.sh
git add scripts/install.sh
git commit -m "feat: (#26) install script for curl-pipe installation"
```

### Task 20: Landing page on grove.cloud

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Add landing page to Cloudflare Worker**

In `worker/src/index.ts`, update the handler for bare `grove.cloud` requests (no subdomain) to return a styled landing page instead of plain text.

Find the section that handles requests without a subdomain and replace its response with:

```typescript
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Grove — AI Development Orchestrator</title>
  <style>
    body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#09090b;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .c{max-width:480px;text-align:center;padding:2rem}
    h1{font-size:2.5rem;margin:0 0 .5rem;color:#34d399}
    .sub{color:#71717a;margin-bottom:2rem}
    pre{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:1rem;text-align:left;overflow-x:auto;font-size:.875rem;color:#a1a1aa}
    code{color:#34d399}
    .links{margin-top:2rem;display:flex;gap:1rem;justify-content:center}
    a{color:#34d399;text-decoration:none}a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="c">
    <h1>Grove</h1>
    <p class="sub">AI development orchestrator for Claude Code</p>
    <pre><code>curl -fsSL https://grove.cloud/install.sh | bash</code></pre>
    <div class="links">
      <a href="https://github.com/bpamiri/grove">GitHub</a>
    </div>
  </div>
</body>
</html>`;
```

Return this HTML when the request hits the root domain without a subdomain.

- [ ] **Step 2: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: (#26) grove.cloud landing page with install instructions"
```

---

## Summary

| Phase | Tasks | Issue | Key deliverables |
|-------|-------|-------|-----------------|
| 1 | 1-3 | #23 | Pipe-based orchestrator, JSONL event parsing |
| 2 | 4-10 | #27 | Test fixtures, evaluator/step-engine/dispatch/cost/stream-parser tests, CI |
| 3 | 11-15 | #24 | Notification dispatcher, Slack/system/webhook channels, event bus wiring |
| 4 | 16-17 | #25 | Analytics API, Dashboard component (timeline, cost, gates) |
| 5 | 18-20 | #26 | Release workflow, install script, landing page |

**Unresolved questions:**
- Does `claude -p` support reading files in the CWD (needed for orchestrator tree analysis)? If not, the orchestrator may need MCP tools configured.
- Should the orchestrator use `--resume` for conversation continuity, or is message injection sufficient?
- Homebrew formula creation deferred — requires a first successful release to get SHA256 hashes.
