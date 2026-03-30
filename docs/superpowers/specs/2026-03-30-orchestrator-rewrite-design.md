# Orchestrator Rewrite: tmux → claude -p --resume

**Issue:** #23 — Replace tmux scraping with structured JSONL communication for orchestrator
**Date:** 2026-03-30

## Overview

Replace the orchestrator's tmux-based interactive session with a multi-call `claude -p --resume` subprocess pattern. Each user message spawns a new `claude -p` process that resumes a persistent Claude Code session. Events are emitted via `<grove-event>` tags in text output and parsed from stream-json. This eliminates the tmux dependency entirely, enabling Windows support and structured output.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Communication model | Multi-call `claude -p --resume` | Eliminates tmux, structured JSONL output, works with subscription auth. Agent SDK ruled out (API key only). |
| Event protocol | `<grove-event>` tags in text | Unambiguous delimiters, no regex needed. Custom tool_use not available at CLI level. |
| Context management | Let Claude Code manage it | 1M context window is large. User can start a fresh session manually when shifting focus. |
| Working directory | `~/.grove/` with `--add-dir` per tree | Orchestrator needs read access to all trees for planning. Neutral CWD avoids tree-switching complexity. |
| Session storage | In-memory broker state | Session ID is ephemeral to broker lifetime. No DB changes needed. |
| tmux removal | Full removal | Workers already use `Bun.spawn()`. Orchestrator was the last tmux consumer. Enables Windows support. |

## 1. Orchestrator Lifecycle

The orchestrator is no longer a long-running process. It's a stateless subprocess spawned per user message that resumes a persistent Claude Code session.

### State Machine

```
IDLE  →(user message)→  RUNNING  →(process exits)→  IDLE
  ↑                                                    |
  +────────────────────────────────────────────────────+
```

### First Message (no session yet)

```bash
claude -p "<user message>" \
  --output-format stream-json \
  --session-id <generated-uuid> \
  --system-prompt "<orchestrator prompt>" \
  --add-dir /path/to/tree1 --add-dir /path/to/tree2 \
  --permission-mode bypassPermissions \
  --verbose
```

### Subsequent Messages (resume existing session)

```bash
claude -p "<user message>" \
  --output-format stream-json \
  --resume <session-id> \
  --verbose
```

### New Session (user-initiated reset)

- Generate a new UUID
- Next message starts a fresh session with the full system prompt + DB state summary
- Old session ID discarded

### Key Details

- `--session-id` on first call lets the broker control the UUID
- `--resume` on subsequent calls continues the conversation with full context
- `--permission-mode bypassPermissions` since Grove manages trust
- Process CWD is `~/.grove/` — all trees accessible via `--add-dir`
- No tmux dependency

## 2. Event Protocol

The orchestrator emits broker commands using `<grove-event>` tags in its text output.

### System Prompt Instruction

```
When you need the broker to take an action, emit an event using this exact format:

<grove-event>{"type":"spawn_worker","tree":"tree-id","task":"W-001","prompt":"..."}</grove-event>
<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"queued"}</grove-event>
```

### Why Tags

- Stream-json output separates text blocks cleanly
- Tags are unambiguous delimiters — split on `<grove-event>` and `</grove-event>`
- The orchestrator won't produce these tags in normal conversation
- No regex needed for event extraction

### Event Types

| Type | Fields | Broker Action |
|------|--------|---------------|
| `spawn_worker` | `tree`, `task`, `prompt`, `path_name?`, `depends_on?` | Create task in DB, enqueue for dispatch |
| `task_update` | `task`, `field`, `value` | Update task field in DB |
| `user_response` | `text` | Relay message to GUI |

### Event Parsing

```typescript
function extractEvents(text: string): BrokerEvent[] {
  const events: BrokerEvent[] = [];
  const regex = /<grove-event>(.*?)<\/grove-event>/gs;
  for (const match of text.matchAll(regex)) {
    const parsed = parseBrokerEvent(match[1]);
    if (parsed) events.push(parsed);
  }
  return events;
}
```

## 3. Message Flow & Real-time Streaming

### Inbound (user → orchestrator)

```
User sends message (web GUI / API / CLI)
  → POST /api/chat → db.addMessage("user", text)
  → broker spawns: claude -p "text" --resume $sessionId --output-format stream-json
  → broker reads stdout stream-json in real-time
```

### Outbound (orchestrator → user + broker)

As the `claude -p` process runs, the broker reads stdout line-by-line:

- **`text` content** → relay to GUI immediately via WebSocket. Real-time streaming — the user sees the orchestrator typing.
- **`text` containing `<grove-event>` tags** → extract and handle events AND relay surrounding text to GUI.
- **`tool_use` blocks** → emit as activity events so the GUI shows "orchestrator is reading files..." etc.
- **`result` block** → process done, extract final cost, mark orchestrator idle.

### Concurrency Guard

Only one `claude -p` subprocess at a time. If a user sends a message while the orchestrator is running, queue it. When the current process exits, dispatch the next queued message. This avoids session corruption from concurrent `--resume` calls.

### Infrastructure Reused

- `stream-parser.ts` patterns for reading JSONL — adapted to read from process stdout
- `bus.emit("message:new", ...)` for GUI relay (unchanged)
- `parseBrokerEvent()` already exists in stream-parser.ts

## 4. Session Management

### In-Memory State

```typescript
interface OrchestratorSession {
  sessionId: string;       // UUID for claude --resume
  status: "idle" | "running";
  pid: number | null;      // PID of current subprocess (null when idle)
  startedAt: string;       // when this session was created
  messageQueue: string[];  // queued messages while running
}
```

In-memory broker state, not a DB table. Broker restart = new session (clean slate, like opening a fresh Claude Code window).

### Lifecycle

| Event | Action |
|-------|--------|
| First user message | Generate UUID, spawn `claude -p --session-id $uuid`, status=running |
| Message while idle | Spawn `claude -p --resume $uuid`, status=running |
| Message while running | Push to messageQueue |
| Process exits | status=idle, pid=null. Pop next queued message if any. |
| "New Session" button | New UUID, clear queue, next message starts fresh with full system prompt |
| `grove down` | Kill subprocess if running, discard state |

## 5. What Gets Removed

### Removed Entirely

- **`src/broker/tmux.ts`** — all tmux operations. Workers already use `Bun.spawn()`.
- **tmux session management** in `src/broker/index.ts` — `createSession`, `killSession`
- **`parseCompletedResponses()`** — regex parser for `⏺` markers and `❯` prompts
- **`scanForJsonEvents()`** — raw JSON grep from pane text
- **`capturePane()` polling loop** — the 2-second interval timer
- **`processedEvents` deduplication Set**
- **Context rotation timer** and 500KB threshold logic

### Modified Significantly

- **`src/agents/orchestrator.ts`** — rewritten. Spawn via `Bun.spawn()`, messages via new subprocess calls, responses via stream-json parsing.
- **`src/broker/index.ts`** — broker startup no longer creates tmux session.
- **`src/cli/commands/up.ts`** — remove tmux dependency from startup.

### Preserved

- **`stream-parser.ts`** — extended, not replaced
- **`worker.ts`** — untouched (already subprocess + stream-json)
- **Event bus, DB, server, dispatch** — unchanged
- **System prompt content** (trees, tasks, event instructions) — delivery mechanism changes, not content

### Net Effect on `grove up`

- Before: start broker → create tmux session → spawn orchestrator in tmux → spawn tunnel
- After: start broker → spawn tunnel. Orchestrator is lazy — first subprocess spawns on first user message.

`grove up` no longer requires tmux. On Windows, it just works.

## 6. GUI Changes

### New Session Button

Add a "New Session" button to the Chat panel header (or sidebar). When clicked:
- Sends a WebSocket action or POST to a new `/api/orchestrator/reset` endpoint
- Broker generates new session UUID, clears message queue
- Next user message starts a fresh orchestrator session

### Activity Indicator

The GUI already shows orchestrator activity. With stream-json, the broker can emit richer activity events:
- "Orchestrator is thinking..." (when text blocks stream in)
- "Orchestrator is reading `src/foo.ts`..." (when tool_use blocks appear)
- "Orchestrator is idle" (when process exits)

No new components needed — existing `message:new` and `worker:activity` patterns cover this.

## 7. Error Handling

| Failure | Recovery |
|---------|----------|
| `claude -p` process crashes (non-zero exit) | Log error, set status=idle, emit error message to GUI. Next user message spawns fresh. |
| `claude` CLI not found | Emit error on `grove up`, abort startup. |
| Malformed stream-json line | Skip line, log warning. Don't crash the broker. |
| `<grove-event>` with invalid JSON | Skip event, log warning. Relay surrounding text to GUI normally. |
| `--resume` fails (session not found) | Fall back to fresh session with `--session-id` (new UUID). |
| Process hangs (no output for N minutes) | Kill process, set status=idle, emit stall warning. Same timeout logic as current `monitor:stall`. |

## 8. Migration Path

This is a **breaking change** for the orchestrator but **transparent to workers, the GUI, and the API**. The event bus contract stays the same — the broker still emits `message:new`, `task:created`, etc. Only the mechanism for generating those events changes.

### Backward Compatibility

- Workers: unchanged. Already use `Bun.spawn()` + stream-json.
- Web GUI: unchanged. Still receives WebSocket events.
- API: unchanged. `/api/chat` still accepts messages.
- CLI: `grove chat` still sends messages via the API.

### tmux Graceful Removal

- If tmux is installed, Grove ignores it (no longer uses it).
- If tmux is not installed, Grove works fine (current behavior: fails on `grove up`).
- The `tmux attach -t grove` instruction in CLI output is removed.
