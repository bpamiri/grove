// Grove v3 — Seed session manager (SAP-native, tmux-free)
// Manages interactive Claude Code brainstorming sessions using the --resume pattern.
// Each user message spawns a new claude process that resumes the session.
// Outputs are parsed from stream-json and broadcast as SAP events.

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
// Stage detection (exported for testing)
// ---------------------------------------------------------------------------

/** Detect the brainstorming stage from Claude's response text */
export function detectSeedStage(text: string): "exploring" | "clarifying" | "proposing" | "designing" | null {
  const lower = text.toLowerCase();
  if (lower.includes("explore") || lower.includes("read the") || lower.includes("survey") || lower.includes("look at the")) return "exploring";
  if (lower.includes("question") || lower.includes("which option") || lower.includes("would you prefer") || lower.includes("a)") || lower.includes("b)")) return "clarifying";
  // Check designing before proposing since "recommended design" should match designing
  if (lower.includes("design") || lower.includes("architecture") || lower.includes("## ")) return "designing";
  if (lower.includes("approaches") || lower.includes("options") || lower.includes("recommend") || lower.includes("trade-off") || lower.includes("tradeoff")) return "proposing";
  return null;
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
    let currentStage: string | null = null;

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

              // Emit streaming chunk
              bus.emit("seed:chunk", { taskId, content: block.text, ts: Date.now() });

              // Detect and broadcast stage changes
              const stage = detectSeedStage(accumulatedText);
              if (stage && stage !== currentStage) {
                currentStage = stage;
                broadcast("seed:stage", { taskId, stage });
              }

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
