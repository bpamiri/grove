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
    "SELECT id, title, status, tree_id FROM tasks WHERE status NOT IN ('completed', 'merged', 'failed', 'closed') ORDER BY created_at DESC LIMIT 20"
  );
  const taskList = activeTasks.length > 0
    ? activeTasks.map(t => `- ${t.id}: [${t.status}] ${t.title} (${t.tree_id || "no tree"})`).join("\n")
    : "No active tasks.";

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
    for (const tree of db.allTrees()) {
      args.push("--add-dir", tree.path);
    }
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--resume", sessionId);
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

// ---------------------------------------------------------------------------
// Internal: dispatch and monitor
// ---------------------------------------------------------------------------

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

  const dbSessionId = `orch-${Date.now()}`;
  db.sessionCreate(dbSessionId, null, "orchestrator", proc.pid);

  monitorOrchestrator(proc, db, dbSessionId);
}

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

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: any;
        try { obj = JSON.parse(trimmed); } catch { continue; }

        if (obj.type === "assistant") {
          for (const block of obj.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              accumulatedText += block.text;

              const events = extractGroveEvents(accumulatedText);
              for (const event of events) {
                handleOrchestratorEvent(event, db);
              }

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
              bus.emit("agent:tool_use", { agentId: dbSessionId, taskId: "orchestrator", tool, input: detail, ts: Date.now() });
            }
          }
        }

        if (obj.type === "result" && obj.cost_usd != null) {
          const costUsd = Number(obj.cost_usd);
          const tokens = Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0);
          db.sessionUpdateCost(dbSessionId, costUsd, tokens);
          bus.emit("agent:cost", { agentId: dbSessionId, taskId: "orchestrator", costUsd, tokens, ts: Date.now() });
        }
      }
    }

    const exitCode = await proc.exited;
    db.sessionEnd(dbSessionId, exitCode === 0 ? "completed" : "failed");

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
// Event handler
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
