// Grove v3 — Orchestrator agent lifecycle
// The orchestrator is a long-running Claude Code subprocess with piped stdin/stdout.
// Communication uses JSONL (--output-format stream-json) instead of tmux scraping.
import { join } from "node:path";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { isAlive } from "./stream-parser";
import { parseOrchestratorEvent, handleOrchestratorEvent } from "./orchestrator-events";
import type { Database } from "../broker/db";

// Context rotation threshold: rotate when log exceeds this size (rough proxy for token usage)
const LOG_SIZE_ROTATION_THRESHOLD = 500_000; // ~500KB of stream-json ≈ heavy context

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
- Update task status: {"type":"task_update","task":"W-001","field":"status","value":"completed"}
  Valid statuses: draft, queued, active, completed, failed
  Use "completed" when an issue is resolved (e.g., already addressed by prior work)
  Use "failed" when a task should be abandoned
- Respond to user: {"type":"user_response","text":"your response here"}

IMPORTANT: When you close GitHub issues or determine tasks are already done, always emit a task_update event to update the Grove DB. Editing your CLAUDE.md is not enough — the task status must be updated via the event.

## Guidelines
- When the user asks you to do something, analyze whether it needs decomposition across trees
- For single-tree tasks, emit one spawn_worker event
- For cross-tree tasks, emit multiple spawn_worker events with depends_on fields
- Always explain your plan to the user before spawning workers
- Monitor worker progress via events the broker sends you
- When workers complete, summarize results for the user`;
}

/** Spawn the orchestrator as a piped subprocess */
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

  // Spawn claude as a piped subprocess
  // -p: non-interactive prompt mode
  // --output-format stream-json: structured JSONL output on stdout
  // --verbose: include tool use events in the stream
  // --dangerously-skip-permissions: automated agent must not block on permission prompts
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    {
      cwd: logDir,
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const pid = proc.pid;

  // Get a writer for stdin so we can send messages to the orchestrator
  let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  if (proc.stdin) {
    stdinWriter = (proc.stdin as WritableStream<Uint8Array>).getWriter();
  }

  db.sessionCreate(sessionId, null, "orchestrator", pid, undefined, logPath);
  db.addEvent(null, sessionId, "orchestrator_started", `Orchestrator spawned (PID: ${pid})`);

  // Set up output monitoring
  let monitorStopped = false;
  const stopMonitor = () => { monitorStopped = true; };

  state = { sessionId, pid, logPath, logDir, proc, stdinWriter, stopMonitor };

  // Start async stdout monitoring
  monitorOutput(proc, logPath, db, () => monitorStopped);

  bus.emit("orchestrator:started", { sessionId, pid });

  // Start rotation check (every 60 seconds)
  if (!rotationCheckInterval) {
    rotationCheckInterval = setInterval(() => checkRotation(db), 60_000);
  }

  return state;
}

/** Send a message to the orchestrator via stdin pipe */
export function sendMessage(text: string): boolean {
  if (!state?.stdinWriter) return false;

  const encoder = new TextEncoder();
  try {
    // Write the message followed by a newline to the stdin pipe
    state.stdinWriter.write(encoder.encode(text + "\n"));
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
    // Stop the output monitor
    state.stopMonitor?.();

    // Close the stdin writer
    if (state.stdinWriter) {
      try { state.stdinWriter.close(); } catch {}
    }

    // Kill the process
    if (state.proc) {
      try { state.proc.kill(); } catch {}
    }

    db.sessionEnd(state.sessionId, "stopped");
    state = null;
  }
}

/**
 * Monitor the orchestrator's stdout stream.
 * Reads JSONL output, writes to log file, and processes events.
 *
 * The stream-json format wraps content in blocks like:
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *
 * Text content that parses as a BrokerEvent (JSON with a `type` field matching
 * spawn_worker/task_update/user_response) is dispatched via handleOrchestratorEvent.
 * Other text content is relayed as an orchestrator message to the web UI.
 */
async function monitorOutput(
  proc: ReturnType<typeof Bun.spawn>,
  logPath: string,
  db: Database,
  isStopped: () => boolean,
): Promise<void> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === "number") return;

  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const logFile = Bun.file(logPath);
  const writer = logFile.writer();
  const decoder = new TextDecoder();

  // Buffer for incomplete lines across chunks
  let lineBuffer = "";

  try {
    while (!isStopped()) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });

      // Write raw output to log file
      writer.write(text);
      writer.flush();

      // Process JSONL lines
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        processStreamLine(trimmed, db);
      }
    }

    // Process any remaining buffered content
    if (lineBuffer.trim()) {
      processStreamLine(lineBuffer.trim(), db);
    }
  } catch {
    // Stream read error — process may have exited
  } finally {
    writer.end();
  }
}

/**
 * Process a single JSONL line from the stream-json output.
 * Extracts text content from assistant messages and checks for broker events.
 */
function processStreamLine(line: string, db: Database): void {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    // Not valid JSON — skip
    return;
  }

  // Handle assistant messages — extract text content blocks
  if (obj.type === "assistant" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "text" && block.text) {
        // Check each line of the text for broker events
        for (const textLine of block.text.split("\n")) {
          const event = parseOrchestratorEvent(textLine);
          if (event) {
            handleOrchestratorEvent(event, db);
          }
        }

        // Relay non-event text as an orchestrator message
        // Filter out lines that are pure JSON events to avoid double-relaying
        const nonEventLines = block.text
          .split("\n")
          .filter((l: string) => !parseOrchestratorEvent(l))
          .join("\n")
          .trim();

        if (nonEventLines) {
          db.addMessage("orchestrator", nonEventLines);
          bus.emit("message:new", {
            message: {
              id: 0,
              source: "orchestrator",
              channel: "main",
              content: nonEventLines,
              created_at: new Date().toISOString(),
            },
          });
        }
      }
    }
  }

  // Handle result events (for cost tracking)
  if (obj.type === "result" && state?.sessionId) {
    if (obj.cost_usd != null) {
      db.sessionUpdateCost(
        state.sessionId,
        Number(obj.cost_usd),
        Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0),
      );
    }
  }
}

/**
 * Session rotation — shift handoff pattern.
 * When the orchestrator's context gets heavy (large log file), we:
 * 1. Build a context summary from DB state
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
  state.stopMonitor?.();
  if (state.stdinWriter) {
    try { state.stdinWriter.close(); } catch {}
  }
  if (state.proc) {
    try { state.proc.kill(); } catch {}
  }
  db.sessionEnd(oldSessionId, "rotated");
  state = null;

  db.addEvent(null, oldSessionId, "orchestrator_rotated", "Session rotated due to context size");

  // Start new session with summary
  const newState = spawn(db, logDir, summary);

  bus.emit("orchestrator:rotated", { oldSessionId, newSessionId: newState.sessionId });
}
