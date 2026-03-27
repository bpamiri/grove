// Grove v3 — Orchestrator agent lifecycle
// The orchestrator is a long-running Claude Code session in tmux.
// The broker spawns it, tails its log, and relays messages.
import { join } from "node:path";
import { mkdirSync, statSync, existsSync } from "node:fs";
import * as tmux from "../broker/tmux";
import { bus } from "../broker/event-bus";
import { tailLog, parseBrokerEvent, isAlive } from "./stream-parser";
import type { Database } from "../broker/db";

const WINDOW_NAME = "orchestrator";

// Context rotation threshold: rotate when log exceeds this size (rough proxy for token usage)
const LOG_SIZE_ROTATION_THRESHOLD = 500_000; // ~500KB of stream-json ≈ heavy context

export interface OrchestratorState {
  sessionId: string;
  pid: number | null;
  logPath: string;
  logDir: string;
  stopTailing: (() => void) | null;
}

let state: OrchestratorState | null = null;
let dbRef: Database | null = null;
let rotationCheckInterval: ReturnType<typeof setInterval> | null = null;

/** Build the orchestrator's system prompt (injected via -p) */
function buildOrchestratorPrompt(db: Database): string {
  const trees = db.allTrees();
  const treeList = trees.map(t => `- ${t.id}: ${t.path}${t.github ? ` (${t.github})` : ""}`).join("\n");

  const activeTasks = db.all<{ id: string; title: string; status: string; tree_id: string }>(
    "SELECT id, title, status, tree_id FROM tasks WHERE status NOT IN ('completed', 'merged', 'failed') ORDER BY created_at DESC LIMIT 20"
  );
  const taskList = activeTasks.length > 0
    ? activeTasks.map(t => `- ${t.id}: [${t.status}] ${t.title} (${t.tree_id || "no tree"})`).join("\n")
    : "No active tasks.";

  return `You are the Grove orchestrator. You plan work, decompose tasks across repos (called "trees"), and delegate to workers.

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
- Update a task: {"type":"task_update","task":"W-001","field":"status","value":"planned"}
- Respond to user: {"type":"user_response","text":"your response here"}

## Guidelines
- When the user asks you to do something, analyze whether it needs decomposition across trees
- For single-tree tasks, emit one spawn_worker event
- For cross-tree tasks, emit multiple spawn_worker events with depends_on fields
- Always explain your plan to the user before spawning workers
- Monitor worker progress via events the broker sends you
- When workers complete, summarize results for the user`;
}

/** Spawn the orchestrator in a tmux window */
export function spawn(db: Database, logDir: string, contextSummary?: string): OrchestratorState {
  if (state?.pid && isAlive(state.pid)) {
    return state;
  }

  mkdirSync(logDir, { recursive: true });
  dbRef = db;

  const sessionId = `orch-${Date.now()}`;
  const logPath = join(logDir, `${sessionId}.jsonl`);

  // Build prompt — include context summary from previous session if rotating
  let prompt = buildOrchestratorPrompt(db);
  if (contextSummary) {
    prompt += `\n\n## Context from Previous Session\nYou are resuming from a previous orchestrator session. Here is the context summary:\n${contextSummary}`;
  }

  // Inject recent messages for continuity
  const recentMsgs = db.recentMessages("main", 20);
  if (recentMsgs.length > 0) {
    const msgHistory = recentMsgs
      .reverse()
      .map(m => `[${m.source}] ${m.content}`)
      .join("\n");
    prompt += `\n\n## Recent Conversation\n${msgHistory}`;
  }

  // Create tmux window with claude command
  const claudeCmd = `claude -p "${prompt.replace(/"/g, '\\"')}" --output-format stream-json > "${logPath}" 2>&1`;
  const windowIdx = tmux.runInWindow(WINDOW_NAME, claudeCmd);

  if (!windowIdx) {
    throw new Error("Failed to create orchestrator tmux window");
  }

  const target = tmux.windowTarget(WINDOW_NAME);
  let pid: number | null = null;

  for (let i = 0; i < 5; i++) {
    pid = tmux.panePid(target);
    if (pid) break;
    Bun.sleepSync(200);
  }

  db.sessionCreate(sessionId, null, "orchestrator", pid ?? undefined, target, logPath);
  db.addEvent(null, sessionId, "orchestrator_started", `Orchestrator spawned (PID: ${pid})`);

  const stopTailing = tailLog(logPath, (line) => {
    const event = parseBrokerEvent(line);
    if (event) {
      handleOrchestratorEvent(event, db);
    }
  });

  state = { sessionId, pid, logPath, logDir, stopTailing };

  bus.emit("orchestrator:started", { sessionId, pid: pid ?? 0 });

  // Start rotation check (every 60 seconds)
  if (!rotationCheckInterval) {
    rotationCheckInterval = setInterval(() => checkRotation(db), 60_000);
  }

  return state;
}

/** Send a message to the orchestrator via tmux */
export function sendMessage(text: string): boolean {
  const target = tmux.windowTarget(WINDOW_NAME);
  return tmux.sendKeys(target, text);
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
    state.stopTailing?.();
    db.sessionEnd(state.sessionId, "stopped");
    state = null;
  }
  tmux.killWindow(tmux.windowTarget(WINDOW_NAME));
}

/**
 * Session rotation — shift handoff pattern.
 * When the orchestrator's context gets heavy (large log file), we:
 * 1. Ask it to summarize its current state
 * 2. Stop the old session
 * 3. Start a new session with the summary injected
 */
function checkRotation(db: Database): void {
  if (!state?.logPath) return;

  try {
    if (!existsSync(state.logPath)) return;
    const stat = statSync(state.logPath);

    if (stat.size >= LOG_SIZE_ROTATION_THRESHOLD) {
      rotate(db);
    }
  } catch {
    // Can't check — skip
  }
}

/** Perform the rotation: capture context, stop old, start new */
function rotate(db: Database): void {
  if (!state) return;

  const oldSessionId = state.sessionId;
  const logDir = state.logDir;

  // Build a context summary from DB state (not from the orchestrator itself — it may be slow)
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
  state.stopTailing?.();
  db.sessionEnd(oldSessionId, "rotated");
  tmux.killWindow(tmux.windowTarget(WINDOW_NAME));
  state = null;

  db.addEvent(null, oldSessionId, "orchestrator_rotated", "Session rotated due to context size");

  // Start new session with summary
  const newState = spawn(db, logDir, summary);

  bus.emit("orchestrator:rotated", { oldSessionId, newSessionId: newState.sessionId });
}

/** Handle events emitted by the orchestrator in its output */
function handleOrchestratorEvent(event: any, db: Database): void {
  switch (event.type) {
    case "spawn_worker":
      bus.emit("task:created", {
        task: {
          id: event.task,
          tree_id: event.tree,
          parent_task_id: null,
          title: event.prompt,
          description: event.prompt,
          status: "ready",
          path_name: "development",
          priority: 0,
          depends_on: event.depends_on ?? null,
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
        },
      });
      break;

    case "user_response":
      db.addMessage("orchestrator", event.text);
      bus.emit("message:new", {
        message: {
          id: 0,
          source: "orchestrator",
          channel: "main",
          content: event.text,
          created_at: new Date().toISOString(),
        },
      });
      break;

    case "task_update":
      if (event.field === "status") {
        db.taskSetStatus(event.task, event.value as string);
        bus.emit("task:status", { taskId: event.task, status: event.value as string });
      }
      break;
  }
}
