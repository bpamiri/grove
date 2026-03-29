// Grove v3 — Seed session manager
// Manages interactive Claude Code brainstorming sessions in tmux windows.
// Each seed session is a conversation between the user and Claude that
// explores a task, asks clarifying questions, and produces a design spec.

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import * as tmux from "./tmux";
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
  windowName: string;
  target: string;
  pid: number | null;
  stopPoller: () => void;
  conversation: ConversationMessage[];
}

type BroadcastFn = (type: string, data: any) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map<string, SeedSession>();
const relayedResponses = new Map<string, Set<string>>(); // per-task dedup
const processedEvents = new Map<string, Set<string>>(); // per-task JSON event dedup

let broadcastFn: BroadcastFn | null = null;

const POLL_MS = 1500;

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
  logDir: string,
): void {
  const taskId = task.id;

  // If already active, no-op
  if (sessions.has(taskId)) return;

  // Create workspace with CLAUDE.md
  const workspaceDir = join(logDir, `seed-workspace-${taskId}`);
  mkdirSync(join(workspaceDir, ".claude"), { recursive: true });

  const prompt = buildSeedPrompt(task, tree);
  writeFileSync(join(workspaceDir, ".claude", "CLAUDE.md"), prompt);

  // Record seed in DB
  db.seedCreate(taskId);

  // Spawn tmux window
  const windowName = `seed-${taskId}`;
  const claudeCmd = `cd "${tree.path}" && CLAUDE_MD="${join(workspaceDir, ".claude", "CLAUDE.md")}" claude --dangerously-skip-permissions`;
  const windowIdx = tmux.runInWindow(windowName, claudeCmd);

  if (!windowIdx) {
    throw new Error(`Failed to create seed tmux window for ${taskId}`);
  }

  const target = tmux.windowTarget(windowName);

  // Get PID
  let pid: number | null = null;
  for (let i = 0; i < 5; i++) {
    pid = tmux.panePid(target);
    if (pid) break;
    Bun.sleepSync(200);
  }

  // Accept workspace trust prompt
  Bun.sleepSync(1000);
  tmux.sendEnter(target);

  // Initialize per-task dedup sets
  relayedResponses.set(taskId, new Set());
  processedEvents.set(taskId, new Set());

  // Start response poller
  const stopPoller = startPoller(taskId, target, db);

  const session: SeedSession = {
    taskId,
    windowName,
    target,
    pid,
    stopPoller,
    conversation: [],
  };

  sessions.set(taskId, session);

  broadcast("seed:started", { taskId });
}

/** Send a user message to the seed session via tmux */
export function sendSeedMessage(taskId: string, text: string, db: Database): boolean {
  const session = sessions.get(taskId);
  if (!session) return false;

  // Record user message
  session.conversation.push({
    role: "user",
    content: text,
    ts: new Date().toISOString(),
  });
  db.seedUpdateConversation(taskId, session.conversation);

  // Broadcast user message
  broadcast("seed:message", {
    taskId,
    role: "user",
    content: text,
  });

  return tmux.sendKeys(session.target, text);
}

/** Stop a seed session, kill tmux window, cleanup */
export function stopSeedSession(taskId: string, db: Database): void {
  const session = sessions.get(taskId);
  if (!session) return;

  session.stopPoller();
  tmux.killWindow(session.target);

  // Persist final conversation
  db.seedUpdateConversation(taskId, session.conversation);

  // Cleanup state
  sessions.delete(taskId);
  relayedResponses.delete(taskId);
  processedEvents.delete(taskId);

  broadcast("seed:stopped", { taskId });
}

/** Check if a seed session is alive */
export function isSeedSessionActive(taskId: string): boolean {
  const session = sessions.get(taskId);
  if (!session) return false;
  return isAlive(session.pid);
}

/** Get conversation history for a seed session */
export function getSeedConversation(taskId: string): ConversationMessage[] {
  const session = sessions.get(taskId);
  if (session) return session.conversation;

  // Fall back to DB if session is no longer in memory
  return [];
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSeedPrompt(
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
// Response poller
// ---------------------------------------------------------------------------

function startPoller(taskId: string, target: string, db: Database): () => void {
  let stopped = false;

  const poll = async () => {
    // Wait for Claude Code to start
    await new Promise(r => setTimeout(r, 5000));

    while (!stopped) {
      try {
        const content = tmux.capturePane(target, 500);

        // Scan for structured JSON events first
        scanForJsonEvents(taskId, content, db);

        // Parse completed response blocks
        const responses = parseCompletedResponses(content);
        const seen = relayedResponses.get(taskId)!;

        for (const text of responses) {
          if (!seen.has(text)) {
            seen.add(text);

            // Cap the set to prevent memory leak
            if (seen.size > 200) {
              const first = seen.values().next().value;
              if (first) seen.delete(first);
            }

            // Record assistant message
            const session = sessions.get(taskId);
            if (session) {
              session.conversation.push({
                role: "assistant",
                content: text,
                ts: new Date().toISOString(),
              });
              db.seedUpdateConversation(taskId, session.conversation);
            }

            broadcast("seed:message", {
              taskId,
              role: "assistant",
              content: text,
            });
          }
        }
      } catch {
        // Capture failed — retry next interval
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  };

  poll();
  return () => { stopped = true; };
}

// ---------------------------------------------------------------------------
// JSON event scanner
// ---------------------------------------------------------------------------

function scanForJsonEvents(taskId: string, content: string, db: Database): void {
  const seen = processedEvents.get(taskId)!;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;

    try {
      const event = JSON.parse(trimmed);
      if (!event.type) continue;

      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);

      // Cap the set
      if (seen.size > 300) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }

      handleSeedEvent(taskId, event, db);
    } catch {
      // Not valid JSON — skip
    }
  }
}

function handleSeedEvent(taskId: string, event: any, db: Database): void {
  switch (event.type) {
    case "seed_html": {
      // Broadcast HTML mockup to the UI
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
      broadcast("seed:message", {
        taskId,
        role: "assistant",
        content: "",
        html: event.html,
      });
      break;
    }

    case "seed_complete": {
      // Store seed in DB
      db.seedComplete(taskId, event.summary ?? "", event.spec ?? "");

      // Broadcast completion
      broadcast("seed:complete", {
        taskId,
        summary: event.summary,
        spec: event.spec,
      });

      // Auto-stop the session
      stopSeedSession(taskId, db);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Response parser — mirrors orchestrator's parseCompletedResponses / isSystemOutput
// ---------------------------------------------------------------------------

/**
 * Parse completed response blocks from tmux pane content.
 * A "completed" response is one followed by an idle prompt (❯ alone).
 *
 * Format:
 *   ❯ user message
 *   ⏺ Claude's response text
 *     continuation
 *   ⏺ Read(file.ts)           ← system, skip
 *     ⎿  file contents         ← sub-content, skip
 *   ───────────────────
 *   ❯                          ← idle prompt
 */
function parseCompletedResponses(content: string): string[] {
  const lines = content.split("\n");
  const results: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Look for user prompt (❯ followed by text)
    if (!trimmed.startsWith("❯") || trimmed.length <= 2) continue;

    const textBlocks: string[][] = [];
    let currentBlock: string[] = [];
    let foundIdlePrompt = false;
    let inResponseBlock = false;

    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();

      // Idle prompt = end of turn
      if (t === "❯" || t === "❯ ") {
        foundIdlePrompt = true;
        break;
      }

      // Another user prompt = end without idle
      if (t.startsWith("❯") && t.length > 2) break;

      // Response block marker
      if (t.startsWith("⏺")) {
        const text = t.slice(1).trim();
        if (text && !isSystemOutput(text)) {
          if (!inResponseBlock && currentBlock.length > 0) {
            textBlocks.push([...currentBlock]);
            currentBlock = [];
          }
          currentBlock.push(text);
          inResponseBlock = true;
        } else {
          if (inResponseBlock && currentBlock.length > 0) {
            textBlocks.push([...currentBlock]);
            currentBlock = [];
          }
          inResponseBlock = false;
        }
        continue;
      }

      // Sub-content of tool/hook output
      if (t.startsWith("⎿")) {
        if (inResponseBlock && currentBlock.length > 0) {
          textBlocks.push([...currentBlock]);
          currentBlock = [];
        }
        inResponseBlock = false;
        continue;
      }

      // tmux separator lines
      if (t.startsWith("───") && t.length > 20) {
        if (inResponseBlock && currentBlock.length > 0) {
          textBlocks.push([...currentBlock]);
          currentBlock = [];
        }
        inResponseBlock = false;
        continue;
      }

      // Continuation lines
      if (inResponseBlock) {
        currentBlock.push(t);
      }
    }

    // Save final block
    if (currentBlock.length > 0) {
      textBlocks.push(currentBlock);
    }

    if (foundIdlePrompt && textBlocks.length > 0) {
      const lastBlock = textBlocks[textBlocks.length - 1];
      while (lastBlock.length > 0 && !lastBlock[0]) lastBlock.shift();
      while (lastBlock.length > 0 && !lastBlock[lastBlock.length - 1]) lastBlock.pop();
      if (lastBlock.length > 0) {
        results.push(lastBlock.join("\n"));
      }
    }
  }

  return results;
}

/** Check if a ⏺ line is system/tool output rather than a response */
function isSystemOutput(text: string): boolean {
  return /^Ran \d+ /.test(text) ||
    /^Read\b/.test(text) || /^Edit\b/.test(text) ||
    /^Write\b/.test(text) || /^Bash\b/.test(text) ||
    /^Grep\b/.test(text) || /^Glob\b/.test(text) ||
    /^Agent\b/.test(text) || /^Search\b/.test(text) ||
    /^LS\b/.test(text) || /^TodoWrite\b/.test(text) ||
    /^Task\b/.test(text) || /^Skill\b/.test(text) ||
    /^WebSearch\b/.test(text) || /^WebFetch\b/.test(text) ||
    text.startsWith("Tool:") ||
    text.startsWith("Thinking") ||
    /^\d+ (file|module|package)s? /.test(text) ||
    /^[A-Z][a-z]+\([^)]*\)/.test(text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(type: string, data: any): void {
  broadcastFn?.(type, data);
}
