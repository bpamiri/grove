# Grove Next 10 — Roadmap Spec

**Date:** 2026-03-30
**Status:** Approved
**Version:** Grove v0.1.16 baseline

## Overview

Ten tasks that take Grove from functional alpha to production-ready orchestrator. Ordered by dependency (Approach C: coupled protocol + early validation). Informed by Orchard's strengths (DAG engine, plugin system, multi-adapter support) and Grove's gaps.

### Dependency Graph

```
T1 (SAP + Tmux Elimination)
├── T2 (Real-time Worker Streaming)
│   ├── T3 (Integration Test Harness)
│   ├── T9 (Observability Dashboard)
│   └── T10 (Interactive Seed Sessions)
├── T4 (Plugin Architecture)
│   ├── T5 (Multi-Agent Adapters)
│   ├── T6 (Worker Checkpointing)
│   └── T7 (Task DAG + Visual Editor)
└── T8 (Config Schema Versioning) — independent
```

### Parallelizable Clusters

- After T1: {T2, T4, T8} in parallel
- After T2 + T4: {T3, T5, T6, T7} in parallel
- After T2: {T9, T10} in parallel

---

## T1: Structured Agent Protocol (SAP) + Tmux Elimination

### Problem

Grove's agent communication is ad-hoc: workers emit stream-json and the broker parses it with regex/heuristics. Seed sessions use tmux pane polling — the **only remaining tmux dependency** in the codebase. Workers, orchestrator, evaluator, and reviewer already use pure `Bun.spawn()` subprocess management.

Tmux blocks Windows support. Ad-hoc parsing blocks reliable streaming, multi-adapter support, and interactive features.

### Correction: Where Tmux Actually Lives

Despite the assumption that workers use tmux, they do not. The tmux dependency is isolated to:

| File | Usage |
|------|-------|
| `src/broker/tmux.ts` (132 lines) | Low-level tmux CLI wrapper |
| `src/broker/seed-session.ts` (501 lines) | Interactive brainstorming sessions — spawns tmux windows, polls pane content, sends keystrokes |
| `src/cli/commands/down.ts` | `tmux kill-session -t grove` cleanup |
| `src/broker/index.ts` | `tmuxSession: "none"` cosmetic field |
| `src/shared/types.ts` | `Session.tmux_pane` field (always null for non-seed) |
| `src/broker/schema-sql.ts` | `tmux_pane TEXT` column |

### Solution

1. **Define SAP** — a typed JSON event protocol for all broker-agent communication
2. **Refactor seed sessions** to use the orchestrator's `--session-id` + `--resume` pattern (new subprocess per user message, session state maintained by Claude Code)
3. **Delete tmux.ts** and all tmux references
4. **Standardize all agent output parsing** through SAP event types

### SAP Event Protocol

Create `src/shared/protocol.ts`:

```typescript
// Broker → Client (WebSocket) events
export type SapEvent =
  // Agent lifecycle
  | { type: "agent:spawned"; agentId: string; role: AgentRole; taskId: string; pid: number; ts: number }
  | { type: "agent:ended"; agentId: string; role: AgentRole; taskId: string; exitCode: number; ts: number }
  | { type: "agent:crashed"; agentId: string; role: AgentRole; taskId: string; error: string; ts: number }

  // Fine-grained activity (from stream-json parsing)
  | { type: "agent:tool_use"; agentId: string; taskId: string; tool: string; input: string; ts: number }
  | { type: "agent:thinking"; agentId: string; taskId: string; snippet: string; ts: number }
  | { type: "agent:text"; agentId: string; taskId: string; content: string; ts: number }
  | { type: "agent:cost"; agentId: string; taskId: string; costUsd: number; tokens: number; ts: number }

  // Seed-specific
  | { type: "seed:response"; taskId: string; content: string; html?: string; ts: number }
  | { type: "seed:complete"; taskId: string; summary: string; spec: string; ts: number }
  | { type: "seed:idle"; taskId: string; ts: number }

  // Task lifecycle (existing events, normalized)
  | { type: "task:status"; taskId: string; status: TaskStatus; ts: number }
  | { type: "task:created"; task: Task; ts: number }

  // Gate results
  | { type: "gate:result"; taskId: string; gate: string; passed: boolean; message: string; ts: number }

  // Merge lifecycle
  | { type: "merge:pr_created"; taskId: string; prNumber: number; prUrl: string; ts: number }
  | { type: "merge:completed"; taskId: string; prNumber: number; ts: number }

  // Cost/budget
  | { type: "cost:warning"; current: number; limit: number; period: string; ts: number }
  | { type: "cost:exceeded"; current: number; limit: number; period: string; ts: number };
```

### Seed Session Refactor

Replace tmux-based seed with orchestrator-style subprocess pattern:

```typescript
// New pattern (like orchestrator.ts):
// First message: claude -p {msg} --session-id {id} --system-prompt {seedPrompt} --output-format stream-json
// Follow-up:     claude -p {msg} --resume {id} --output-format stream-json

interface SeedSession {
  taskId: string;
  sessionId: string;          // claude session ID for --resume
  status: "idle" | "running";
  pid: number | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  conversation: ConversationMessage[];
  pendingDescription?: string;
  isFirstMessage: boolean;
}
```

**Key difference from current seed-session.ts:** Instead of running a persistent tmux REPL and injecting keystrokes, each user message spawns a new `claude` process that `--resume`s the session. Claude Code maintains conversation state across processes via its built-in session persistence.

**What gets deleted:**
- `src/broker/tmux.ts` — entire file (132 lines)
- `tmux.runInWindow()`, `tmux.capturePane()`, `tmux.sendKeys()` calls in seed-session
- `parseCompletedResponses()` function (370-476) — no longer needed; stream-json replaces pane scraping
- `isSystemOutput()` function (479-492) — same reason
- `startPoller()` function (229-295) — replaced by subprocess stdout monitoring
- `tmux kill-session -t grove` in `down.ts`

**What gets rewritten:**
- `startSeedSession()` — spawn subprocess instead of tmux window
- `sendSeedMessage()` — spawn new `--resume` process instead of tmux.sendKeys
- `stopSeedSession()` — kill process instead of tmux window
- `monitorSeedSession()` — new function, reads stream-json stdout (pattern from worker.ts monitorWorker)

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/shared/protocol.ts` | SAP event type definitions |
| Rewrite | `src/broker/seed-session.ts` | Replace tmux with --resume subprocess pattern |
| Delete | `src/broker/tmux.ts` | Entire file |
| Modify | `src/agents/worker.ts` | Emit SAP events instead of ad-hoc bus.emit |
| Modify | `src/agents/orchestrator.ts` | Emit SAP events |
| Modify | `src/agents/reviewer.ts` | Emit SAP events |
| Modify | `src/broker/server.ts` | Broadcast SAP events over WebSocket |
| Modify | `src/broker/event-bus.ts` | Update EventBusMap with SAP types |
| Modify | `src/shared/types.ts` | Remove `tmux_pane` from Session, remove `"tmux"` from BrokerEvent |
| Modify | `src/broker/index.ts` | Remove `tmuxSession` from BrokerInfo |
| Modify | `src/cli/commands/down.ts` | Remove tmux kill-session call |
| Modify | `src/broker/schema-sql.ts` | Keep `tmux_pane` column (backwards compat) but never populate |

### Acceptance Criteria

- [ ] All tmux imports and calls removed from codebase
- [ ] `src/broker/tmux.ts` deleted
- [ ] Seed sessions work via --resume subprocess pattern
- [ ] All agents emit typed SAP events
- [ ] SAP event types exported from `src/shared/protocol.ts`
- [ ] WebSocket broadcasts use SAP event format
- [ ] All existing tests pass
- [ ] New unit tests for seed session --resume pattern
- [ ] Works on macOS and Windows (no tmux binary required)

### Testing Strategy

- Unit test seed session spawn/resume/stop lifecycle with mock claude binary
- Unit test SAP event parsing from stream-json lines
- Verify existing worker/evaluator/orchestrator tests still pass
- Manual test: start seed session, send 3+ messages, receive responses, emit seed_complete

---

## T2: Real-time Worker Output Streaming

### Problem

Workers write stream-json to log files, but the GUI can only see coarse `worker:activity` events. Users can't watch what a worker is doing in real-time — they see "editing src/foo.ts" but not the actual tool invocations, thinking process, or file changes as they happen.

### Solution

Parse worker stream-json output into fine-grained SAP events in real-time, broadcast them over WebSocket, and render a live activity feed in the GUI.

### Backend Changes

**`src/agents/worker.ts` — monitorWorker():**

Currently parses stream-json and emits coarse `worker:activity`. Change to emit fine-grained SAP events:

```typescript
// Current (coarse):
bus.emit("worker:activity", { taskId, msg: `${tool}: ${file}` });

// New (fine-grained SAP):
bus.emit("agent:tool_use", { agentId: sessionId, taskId, tool, input: file, ts: Date.now() });
bus.emit("agent:thinking", { agentId: sessionId, taskId, snippet, ts: Date.now() });
bus.emit("agent:text", { agentId: sessionId, taskId, content: cleanText, ts: Date.now() });
```

**`src/broker/server.ts` — WebSocket broadcast:**

Add batched forwarding for high-frequency events:

```typescript
// Batch agent:tool_use, agent:thinking, agent:text events
// Flush every 100ms to avoid flooding WebSocket clients
// Other events (task:status, gate:result) sent immediately
```

Maintain a per-task ring buffer (last 100 events) so new WebSocket connections can catch up on current worker activity without replaying the entire log.

**Backward compatibility:** Keep emitting `worker:activity` alongside SAP events (deprecated, remove in future version). Existing GUI code continues to work until updated.

### Frontend Changes

**New component: `web/src/components/WorkerActivityFeed.tsx`**

Live scrolling feed of worker activity for the selected task:

```
┌─ Worker Activity: W-042 ──────────────────────┐
│ 10:32:15  Read src/broker/server.ts           │
│ 10:32:16  thinking: Analyzing the API...      │
│ 10:32:18  Grep "handleWebSocket"              │
│ 10:32:19  Edit src/broker/server.ts           │
│ 10:32:21  Bash npm test                       │
│ 10:32:25  thinking: Tests pass, moving to...  │
│ ▌ (live cursor)                               │
└───────────────────────────────────────────────┘
```

Features:
- Auto-scroll with "pin to bottom" toggle
- Timestamp prefix (HH:MM:SS)
- Color-coded by event type (tool = blue, thinking = gray, text = white)
- Truncate long inputs (expandable on click)
- Pause/resume streaming (buffer while paused)

**Integration in TaskDetail:**
- Show WorkerActivityFeed when task is `active`
- Collapse to last-activity summary when task completes
- Show "No worker active" when task is idle/draft/queued

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `web/src/components/WorkerActivityFeed.tsx` | Live activity feed component |
| Modify | `src/agents/worker.ts` | Emit fine-grained SAP events |
| Modify | `src/agents/reviewer.ts` | Same SAP event emission |
| Modify | `src/broker/server.ts` | Batched WebSocket broadcast, ring buffer |
| Modify | `web/src/App.tsx` | Wire activity feed into task detail |
| Modify | `web/src/hooks/useWebSocket.ts` | Handle new SAP event types |

### Acceptance Criteria

- [ ] Worker emits `agent:tool_use`, `agent:thinking`, `agent:text` SAP events in real-time
- [ ] Events broadcast over WebSocket with 100ms batching
- [ ] New WebSocket connections receive ring buffer catch-up
- [ ] WorkerActivityFeed component renders live activity
- [ ] Auto-scroll, pause, color-coding, truncation all work
- [ ] No perceptible latency increase in worker execution
- [ ] Existing `worker:activity` events still emitted (backward compat)

### Testing Strategy

- Unit test stream-json line → SAP event parsing
- Unit test ring buffer (add, catch-up, overflow)
- Unit test batched broadcast timing
- Manual test: dispatch task, watch live feed in GUI, verify events appear within ~200ms

---

## T3: Integration Test Harness

### Problem

Grove has 384 unit tests but zero integration tests. The full task lifecycle (create → dispatch → worker → evaluate → merge) has never been tested end-to-end. The new SAP protocol (T1) and streaming (T2) add more surface area that needs validation.

### Solution

Build a test harness with a mock Claude CLI binary that simulates agent behavior, allowing end-to-end lifecycle tests without real API calls.

### Mock Claude Binary

Create `tests/fixtures/mock-claude.ts` — a Bun script that mimics Claude Code's `--output-format stream-json` behavior:

```typescript
// Usage: bun tests/fixtures/mock-claude.ts -p "prompt" --output-format stream-json [--session-id X] [--resume X]
//
// Behavior controlled by MOCK_CLAUDE_BEHAVIOR env var:
// - "success" — emit assistant message + tool_use + result with cost
// - "fail" — emit error result
// - "slow" — add 2s delay between events
// - "seed" — emit seed_complete JSON event
// - "crash" — exit with code 1 mid-stream
//
// Supports --resume: stores/loads session state from /tmp/mock-claude-sessions/

const behavior = process.env.MOCK_CLAUDE_BEHAVIOR ?? "success";
// ... emit stream-json lines to stdout based on behavior
```

Compile to a standalone binary (`tests/fixtures/mock-claude`) that can be placed on PATH to replace the real `claude` CLI during tests.

### Test Framework

Create `tests/integration/helpers.ts`:

```typescript
export async function createTestBroker(opts?: {
  mockBehavior?: string;
  config?: Partial<GroveConfig>;
}): Promise<{
  db: Database;
  port: number;
  cleanup: () => Promise<void>;
}> {
  // 1. Create temp directory for ~/.grove/
  // 2. Create temp git repo (tree)
  // 3. Write grove.yaml with mock-claude on PATH
  // 4. Initialize broker with test DB
  // 5. Return db handle + port + cleanup function
}
```

### Test Suites

**`tests/integration/task-lifecycle.test.ts`** (~15 tests):

- Create task via API → verify DB state
- Dispatch task → verify worker spawned (mock-claude process started)
- Worker completes → verify evaluator runs gates
- Gates pass → verify PR creation attempted
- Gates fail → verify worker re-dispatched (retry)
- Task with max_retries=0 fails gates → verify marked failed
- Cancel active task → verify worker killed, task paused
- Resume paused task → verify worker re-spawned at correct step

**`tests/integration/seed-lifecycle.test.ts`** (~8 tests):

- Start seed session → verify mock-claude spawned with --session-id
- Send seed message → verify mock-claude spawned with --resume
- Receive seed response → verify WebSocket broadcast
- seed_complete event → verify DB updated, session stopped
- Stop seed session → verify process killed, conversation persisted
- Multiple concurrent seeds → verify independent sessions

**`tests/integration/sap-compliance.test.ts`** (~10 tests):

- Worker emits correct SAP events for each stream-json line type
- Orchestrator emits correct SAP events
- Seed session emits correct SAP events
- All SAP events have required fields (type, ts, taskId/agentId)
- WebSocket clients receive events in correct order
- Ring buffer provides catch-up for late-joining clients

**`tests/integration/batch-dispatch.test.ts`** (~5 tests):

- Analyze draft tasks → verify wave derivation
- Dispatch wave → verify concurrent worker spawning respects max_workers
- Wave 1 completes → verify wave 2 auto-dispatched
- Task in wave fails → verify dependent waves blocked

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `tests/fixtures/mock-claude.ts` | Mock Claude CLI binary |
| Create | `tests/integration/helpers.ts` | Test broker factory + utilities |
| Create | `tests/integration/task-lifecycle.test.ts` | End-to-end task tests |
| Create | `tests/integration/seed-lifecycle.test.ts` | Seed session tests |
| Create | `tests/integration/sap-compliance.test.ts` | Protocol validation tests |
| Create | `tests/integration/batch-dispatch.test.ts` | Batch/wave dispatch tests |
| Modify | `package.json` | Add `test:integration` script |

### Acceptance Criteria

- [ ] Mock claude binary supports success/fail/slow/seed/crash behaviors
- [ ] Mock claude supports --session-id and --resume (session state in /tmp)
- [ ] All integration test suites pass
- [ ] Tests run in < 30 seconds (no real API calls)
- [ ] Tests are isolated (temp dirs, random ports, cleanup)
- [ ] `bun test:integration` runs all integration tests
- [ ] CI-friendly (no tmux, no real claude, no network)

---

## T4: Plugin Architecture

### Problem

Grove's gates, notification channels, and step types are hardcoded. Users can't add custom quality checks (security scan, type check, bundle size), custom notification channels (Discord, Teams, PagerDuty), or custom pipeline behaviors without modifying Grove's source code.

### Solution

A lightweight plugin system with JSON manifests, JavaScript modules, and a hook-based execution model. Plugins live in `~/.grove/plugins/` and register handlers for specific lifecycle events.

### Plugin Manifest Format

Each plugin is a directory in `~/.grove/plugins/`:

```
~/.grove/plugins/
  security-scan/
    plugin.json        # manifest
    index.ts           # entry point (compiled to index.js)
  discord-notify/
    plugin.json
    index.ts
```

**plugin.json:**

```json
{
  "name": "security-scan",
  "version": "1.0.0",
  "description": "Run semgrep security scan as a quality gate",
  "author": "grove-community",
  "hooks": {
    "gate:custom": {
      "description": "Security scan gate",
      "timeout": 300
    }
  },
  "config": {
    "rules": {
      "type": "string",
      "default": "auto",
      "description": "Semgrep ruleset to use"
    }
  }
}
```

### Hook System

Plugins register handlers for lifecycle hooks. The plugin host invokes them at the right time.

**Available hooks:**

| Hook | Trigger | Input | Expected Output |
|------|---------|-------|-----------------|
| `gate:custom` | After built-in gates pass | `{ taskId, worktreePath, tree, task }` | `{ passed: boolean, message: string }` |
| `step:pre` | Before any pipeline step executes | `{ taskId, step, tree }` | `{ proceed: boolean, reason?: string }` |
| `step:post` | After any pipeline step completes | `{ taskId, step, outcome, tree }` | void |
| `notify:custom` | When a notification event fires | `{ event, taskId, summary, detail }` | void |
| `worker:pre_spawn` | Before worker subprocess starts | `{ taskId, tree, prompt }` | `{ prompt?: string }` (can modify prompt) |
| `worker:post_complete` | After worker finishes | `{ taskId, exitCode, filesModified }` | void |
| `adapter:register` | On broker startup (for T5) | `{ registry }` | void (registers adapter) |

### Plugin Host

Create `src/plugins/host.ts`:

```typescript
export class PluginHost {
  private plugins: Map<string, LoadedPlugin>;
  private hooks: Map<string, HookHandler[]>;

  /** Discover and load plugins from ~/.grove/plugins/ */
  async loadAll(pluginDir: string): Promise<void>;

  /** Load a single plugin by name */
  async load(name: string, pluginDir: string): Promise<void>;

  /** Run all handlers for a hook, in priority order */
  async runHook<T>(hook: string, input: T, opts?: { timeout?: number }): Promise<T>;

  /** Run gate hooks specifically (returns aggregate pass/fail) */
  async runGateHooks(input: GateInput): Promise<GateResult[]>;

  /** List loaded plugins */
  list(): PluginInfo[];

  /** Get plugin config */
  getConfig(name: string): Record<string, unknown>;

  /** Update plugin config */
  setConfig(name: string, config: Record<string, unknown>): void;
}
```

**Hook execution model:**
- Handlers run in registration order
- Each handler has a configurable timeout (default 60s, max 300s for gates)
- Handler errors are caught and logged — never crash the broker
- Gate hooks return `{ passed, message }` — any failure fails the gate
- Pre-hooks return `{ proceed: boolean }` — `false` skips the step

### Integration with Existing Code

**Evaluator (`src/agents/evaluator.ts`):**
After built-in gates pass, call `pluginHost.runGateHooks()` for custom gates.

**Pipeline (`src/engine/step-engine.ts`):**
Before/after each step, call `pluginHost.runHook("step:pre")` and `pluginHost.runHook("step:post")`.

**Notifications (`src/notifications/dispatcher.ts`):**
After built-in channels, call `pluginHost.runHook("notify:custom")`.

**Worker (`src/agents/worker.ts`):**
Before spawning, call `pluginHost.runHook("worker:pre_spawn")` to allow prompt modification.

### CLI Commands

```
grove plugins list              # Show loaded plugins + status
grove plugins enable <name>     # Enable a plugin
grove plugins disable <name>    # Disable without deleting
grove plugins config <name>     # Show/edit plugin config
```

### API Endpoints

```
GET  /api/plugins               # List plugins + status
POST /api/plugins/:name/enable  # Enable
POST /api/plugins/:name/disable # Disable
GET  /api/plugins/:name/config  # Get config
PUT  /api/plugins/:name/config  # Update config
```

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/plugins/host.ts` | Plugin host with hook system |
| Create | `src/plugins/types.ts` | Plugin manifest, hook, config types |
| Create | `src/plugins/loader.ts` | Plugin discovery and module loading |
| Create | `src/cli/commands/plugins.ts` | CLI commands for plugin management |
| Modify | `src/agents/evaluator.ts` | Call gate hooks after built-in gates |
| Modify | `src/engine/step-engine.ts` | Call step:pre/step:post hooks |
| Modify | `src/notifications/dispatcher.ts` | Call notify:custom hooks |
| Modify | `src/agents/worker.ts` | Call worker:pre_spawn hook |
| Modify | `src/broker/index.ts` | Initialize PluginHost on startup |
| Modify | `src/broker/server.ts` | Add /api/plugins endpoints |
| Modify | `src/cli/index.ts` | Register plugins subcommand |

### Acceptance Criteria

- [ ] Plugins discovered from `~/.grove/plugins/` on broker startup
- [ ] Hook system executes handlers with timeout protection
- [ ] Custom gate plugin can fail a task's evaluation
- [ ] Custom notification plugin receives events
- [ ] `grove plugins list` shows loaded plugins
- [ ] API endpoints for plugin management work
- [ ] Plugin errors never crash the broker
- [ ] Unit tests for plugin loading, hook execution, timeout handling

---

## T5: Multi-Agent Adapter Layer

### Problem

Grove is hardcoded to Claude Code (`claude` CLI). Users who want to use Codex CLI, Aider, or Gemini CLI for specific tasks — or who want to fall back to a different agent when one is unavailable — cannot.

### Solution

Extract Claude Code-specific logic into an adapter, define an abstract adapter interface, and add adapters for other CLI agents. Per-task adapter selection via config or task field.

### Adapter Interface

Create `src/agents/adapters/types.ts`:

```typescript
export interface AgentAdapter {
  /** Unique identifier (e.g., "claude-code", "codex-cli", "aider") */
  readonly name: string;

  /** Check if the agent CLI is available on PATH */
  isAvailable(): boolean;

  /** Spawn a one-shot agent process for a task */
  spawn(opts: SpawnOpts): SpawnResult;

  /** Spawn a resumable session (for seed/orchestrator multi-turn) */
  spawnSession(opts: SessionSpawnOpts): SpawnResult;

  /** Resume an existing session with a new message */
  resumeSession(opts: ResumeOpts): SpawnResult;

  /** Parse a stream-json line into a SAP event (or null if not recognized) */
  parseOutputLine(line: string, context: ParseContext): SapEvent | null;

  /** Extract final cost from completed log file */
  parseCost(logPath: string): CostResult;
}

export interface SpawnOpts {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
  systemPrompt?: string;
  additionalArgs?: string[];
}

export interface SpawnResult {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
  sessionId?: string;  // for resumable sessions
}
```

### Built-in Adapters

**`src/agents/adapters/claude-code.ts`** — extract from current worker.ts/orchestrator.ts:
- Spawns: `claude -p {prompt} --output-format stream-json --verbose`
- Resume: `claude -p {msg} --resume {sessionId}`
- Parses: Claude's stream-json format (assistant, tool_use, result)
- Cost: reads `{type: "result", cost_usd}` from log

**`src/agents/adapters/codex-cli.ts`** — OpenAI Codex CLI:
- Spawns: `codex -q --json {prompt}`
- Parses: Codex's JSON output format
- No resume support (one-shot only)

**`src/agents/adapters/aider.ts`** — Aider:
- Spawns: `aider --yes-always --no-git --message {prompt}`
- Parses: Aider's output format
- No resume support

**`src/agents/adapters/gemini-cli.ts`** — Google Gemini CLI:
- Spawns: `gemini -p {prompt} --output-format json`
- Parses: Gemini's JSON output
- No resume support

**Resume constraint:** Adapters without `resumeSession()` support cannot be used for multi-turn features (seed sessions, orchestrator). These always fall back to the Claude Code adapter regardless of task/tree adapter setting. The adapter interface marks resume as optional; callers check `adapter.supportsResume` before attempting.

### Adapter Registry

Create `src/agents/adapters/registry.ts`:

```typescript
export class AdapterRegistry {
  private adapters: Map<string, AgentAdapter>;

  register(adapter: AgentAdapter): void;
  get(name: string): AgentAdapter | undefined;
  getDefault(): AgentAdapter;
  listAvailable(): AgentAdapter[];

  /** Auto-detect available adapters by checking PATH */
  detectAvailable(): string[];
}
```

### Per-Task Adapter Selection

**grove.yaml:**

```yaml
settings:
  default_adapter: claude-code  # global default

trees:
  myapp:
    adapter: codex-cli  # per-tree override
```

**Task-level:** Add `adapter` field to Task type. Set during task creation. Falls through: task → tree → global default.

### Refactoring worker.ts

`spawnWorker()` currently has Claude-specific logic inlined. Refactor to:

```typescript
// Before (in worker.ts):
const proc = Bun.spawn(["claude", "-p", prompt, "--verbose", ...], { ... });

// After:
const adapter = registry.get(task.adapter ?? treeConfig.adapter ?? config.settings.default_adapter);
const { proc, pid } = adapter.spawn({ prompt, cwd: worktreePath, logPath, ... });
```

The monitor loop calls `adapter.parseOutputLine()` instead of inline JSON parsing.

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/agents/adapters/types.ts` | Adapter interface + types |
| Create | `src/agents/adapters/registry.ts` | Adapter registry |
| Create | `src/agents/adapters/claude-code.ts` | Claude Code adapter (extract from worker/orchestrator) |
| Create | `src/agents/adapters/codex-cli.ts` | Codex CLI adapter |
| Create | `src/agents/adapters/aider.ts` | Aider adapter |
| Create | `src/agents/adapters/gemini-cli.ts` | Gemini CLI adapter |
| Modify | `src/agents/worker.ts` | Use adapter from registry instead of inline claude spawn |
| Modify | `src/agents/orchestrator.ts` | Use adapter for spawn/resume |
| Modify | `src/agents/reviewer.ts` | Use adapter for spawn |
| Modify | `src/broker/seed-session.ts` | Use adapter for spawn/resume |
| Modify | `src/shared/types.ts` | Add `adapter` field to Task, SettingsConfig |
| Modify | `src/broker/schema-sql.ts` | Add `adapter TEXT` column to tasks |
| Modify | `src/broker/index.ts` | Initialize registry, detect available adapters |
| Modify | `src/broker/server.ts` | Add GET /api/adapters endpoint |

### Acceptance Criteria

- [ ] AgentAdapter interface defined with spawn/resume/parse/cost methods
- [ ] Claude Code adapter extracted — all existing behavior preserved
- [ ] Codex, Aider, Gemini adapters implement interface (spawn + parse)
- [ ] AdapterRegistry auto-detects available CLIs on PATH
- [ ] Per-task adapter selection works (task → tree → global fallback)
- [ ] Worker, orchestrator, reviewer, seed all use registry
- [ ] `GET /api/adapters` returns available adapters
- [ ] All existing tests pass (Claude Code adapter is default)
- [ ] Unit tests for each adapter's parseOutputLine

---

## T6: Worker Checkpointing & Resume

### Problem

When a worker is killed (budget exceeded, stall timeout, broker crash, user pause), all in-progress work that hasn't been committed is lost. On retry, the worker starts from scratch with only a text summary of prior work. For long-running tasks, this wastes time and money.

### Solution

Workers commit work-in-progress before shutdown and write a structured checkpoint file. On resume, the worker receives the checkpoint context in its CLAUDE.md overlay and can continue from where it left off.

### Checkpoint Format

```typescript
interface Checkpoint {
  taskId: string;
  stepId: string;
  stepIndex: number;
  timestamp: string;
  commitSha: string;           // WIP commit SHA
  filesModified: string[];     // files in WIP commit
  sessionSummary: string;      // what was accomplished
  nextAction: string;          // what the worker planned to do next
  costSoFar: number;           // cumulative cost
  tokensSoFar: number;         // cumulative tokens
}
```

### Worker Shutdown Protocol

When a worker receives a kill signal (SIGTERM from `stopWorker()`, budget pause, or stall timeout):

1. **Graceful period:** Send SIGTERM, wait `settings.graceful_shutdown_seconds` (default 10s) for worker to finish current tool call
2. **WIP commit:** If worker has uncommitted changes, broker runs:
   ```bash
   cd {worktree} && git add -A && git commit -m "grove: WIP checkpoint for {taskId}"
   ```
3. **Write checkpoint:** Broker writes `{worktree}/.grove/checkpoint.json`
4. **Store in DB:** Save checkpoint JSON in `tasks.checkpoint` column
5. **Kill:** If process still alive after graceful period, SIGKILL

### Worker Resume Protocol

When a task resumes (retry, manual resume, broker restart recovery):

1. **Load checkpoint** from DB or `{worktree}/.grove/checkpoint.json`
2. **Verify WIP commit** exists in worktree git history
3. **Deploy CLAUDE.md overlay** with checkpoint context:
   ```markdown
   ## Checkpoint — Resuming from prior session
   - **Step:** {stepId} (index {stepIndex})
   - **Last commit:** {commitSha}
   - **Files modified:** {filesModified}
   - **Summary:** {sessionSummary}
   - **Next planned action:** {nextAction}

   Continue from where you left off. The WIP commit contains your in-progress work.
   Do NOT repeat work that's already committed.
   ```
4. **Spawn worker** with resume prompt

### CLAUDE.md Session Summary Enhancement

Update `src/shared/sandbox.ts` — the worker's CLAUDE.md overlay instructions to include:

```markdown
## Before Shutdown
If you receive a signal to stop, or if you're about to exceed your task budget:
1. Commit all current work with message "grove: WIP checkpoint for {taskId}"
2. Write a session summary to .grove/session-summary.md describing:
   - What you accomplished
   - What you planned to do next
   - Any blockers or decisions needed
```

This is a **best-effort** instruction — the worker may not have time to follow it if killed abruptly, which is why the broker also handles WIP commits.

### DB Schema Change

Add to tasks table:

```sql
ALTER TABLE tasks ADD COLUMN checkpoint TEXT;  -- JSON, nullable
```

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/agents/checkpoint.ts` | Checkpoint creation, loading, WIP commit logic |
| Modify | `src/agents/worker.ts` | Graceful shutdown with checkpoint before kill |
| Modify | `src/shared/sandbox.ts` | CLAUDE.md overlay includes checkpoint context + shutdown instructions |
| Modify | `src/engine/step-engine.ts` | Resume from checkpoint step/index |
| Modify | `src/monitor/health.ts` | Checkpoint before marking stalled worker as crashed |
| Modify | `src/broker/dispatch.ts` | Load checkpoint when re-dispatching retried task |
| Modify | `src/shared/types.ts` | Add `checkpoint` field to Task |
| Modify | `src/broker/schema-sql.ts` | Add checkpoint column |
| Modify | `src/broker/db.ts` | Add checkpointSave/checkpointLoad helpers |

### Acceptance Criteria

- [ ] Worker graceful shutdown creates WIP commit if uncommitted changes exist
- [ ] Checkpoint JSON written to worktree and saved to DB
- [ ] Resumed worker receives checkpoint context in CLAUDE.md overlay
- [ ] Step engine resumes at correct step from checkpoint
- [ ] Stall timeout creates checkpoint before killing
- [ ] Budget pause creates checkpoint before stopping spawning
- [ ] Unit tests for checkpoint create/load/WIP commit
- [ ] Integration test: spawn → pause → resume → verify continues from checkpoint

---

## T7: Task Dependency DAG + Visual Editor

### Problem

Grove's batch planner derives execution waves from file-overlap heuristics, but users can't define explicit task-to-task dependencies. The existing `depends_on` field is a comma-separated string — no cycle detection, no visualization, no topological dispatch ordering.

### Solution

A proper dependency DAG with cycle detection, topological dispatch, critical path analysis, and a visual graph editor in the GUI using ReactFlow.

### DAG Engine

Create `src/batch/dag.ts`:

```typescript
/** Validate DAG — returns cycle path if invalid, null if valid */
export function detectCycle(taskIds: string[], edges: DagEdge[]): string[] | null;

/** Topological sort — returns task IDs in valid execution order */
export function topoSort(taskIds: string[], edges: DagEdge[]): string[];

/** Get tasks with all dependencies satisfied */
export function readyTasks(taskIds: string[], edges: DagEdge[], completedIds: Set<string>): string[];

/** Compute critical path (longest dependency chain) */
export function criticalPath(taskIds: string[], edges: DagEdge[], durations: Map<string, number>): string[];

export interface DagEdge {
  from: string;  // task ID (dependency)
  to: string;    // task ID (dependent)
  type: "dependency" | "on_failure";
}
```

Algorithms: DFS 3-color cycle detection (same as Orchard), Kahn's algorithm for topological sort.

### DB Schema Changes

Replace comma-separated `depends_on` with a proper edge table:

```sql
CREATE TABLE task_edges (
  from_task TEXT NOT NULL REFERENCES tasks(id),
  to_task TEXT NOT NULL REFERENCES tasks(id),
  edge_type TEXT NOT NULL DEFAULT 'dependency',  -- 'dependency' | 'on_failure'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_task, to_task)
);
CREATE INDEX idx_task_edges_to ON task_edges(to_task);
```

**Migration:** On broker startup, if `task_edges` table is empty but tasks have `depends_on` values, parse comma-separated IDs into `task_edges` rows. Run once automatically; idempotent. Keep `depends_on` column as read-only cache for backward compat (updated on edge creation for older clients).

### Dispatch Integration

Modify `src/broker/dispatch.ts` to use DAG-aware ordering:

```typescript
// Current: simple queue with isTaskBlocked() check
// New: use readyTasks() from DAG engine to determine dispatchable tasks

function getDispatchable(db: Database): string[] {
  const allQueued = db.tasksByStatus("queued");
  const completed = new Set(db.tasksByStatus("completed").map(t => t.id));
  const edges = db.allTaskEdges();
  return readyTasks(allQueued.map(t => t.id), edges, completed);
}
```

### Auto-Dependency Detection

Enhance batch analysis to suggest dependencies:

```typescript
// In src/batch/analyze.ts:
// After computing file overlaps, suggest dependency edges:
// If task A and task B share files, and A is "add X" while B is "update X",
// suggest A → B dependency
export function suggestDependencies(tasks: TaskAnalysis[], overlaps: OverlapEntry[]): SuggestedEdge[];
```

### Visual Editor

Create `web/src/components/DagEditor.tsx` using ReactFlow:

Features:
- Nodes = tasks (colored by status: gray=draft, blue=queued, yellow=active, green=completed, red=failed)
- Edges = dependencies (solid=dependency, dashed=on_failure)
- Drag to create edges between tasks
- Click node to view task detail
- Critical path highlighted in bold
- Auto-layout (dagre algorithm)
- "Add Dependency" button + "Remove Dependency" on right-click
- Cycle detection with visual feedback (flash red if cycle would be created)
- Wave bands shown as horizontal lanes

### API Endpoints

```
GET    /api/tasks/dag                    # Full DAG (nodes + edges)
POST   /api/tasks/edges                  # Add edge { from, to, type }
DELETE /api/tasks/edges/:from/:to        # Remove edge
GET    /api/tasks/dag/critical-path      # Critical path task IDs
POST   /api/tasks/dag/validate           # Check for cycles
GET    /api/tasks/dag/ready              # Currently dispatchable tasks
```

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/batch/dag.ts` | DAG algorithms (cycle detection, topo sort, ready tasks, critical path) |
| Create | `web/src/components/DagEditor.tsx` | ReactFlow visual editor |
| Modify | `src/broker/schema-sql.ts` | Add task_edges table |
| Modify | `src/broker/db.ts` | Edge CRUD, migration from depends_on, DAG queries |
| Modify | `src/broker/dispatch.ts` | DAG-aware dispatch ordering |
| Modify | `src/broker/server.ts` | Add DAG API endpoints |
| Modify | `src/batch/analyze.ts` | suggestDependencies() from overlap data |
| Modify | `web/src/App.tsx` | Add DAG view tab/toggle |
| Modify | `web/package.json` | Add @xyflow/react dependency |

### Acceptance Criteria

- [ ] DAG cycle detection prevents invalid dependency creation
- [ ] Topological sort produces valid execution order
- [ ] readyTasks() correctly identifies dispatchable tasks
- [ ] Critical path computed and highlighted in UI
- [ ] Visual editor renders task DAG with ReactFlow
- [ ] Drag-to-connect creates edges (with cycle prevention)
- [ ] Dispatch uses DAG ordering instead of simple queue
- [ ] Migration converts existing depends_on to task_edges
- [ ] Unit tests for all DAG algorithms
- [ ] 10+ tasks with complex dependencies renders correctly

---

## T8: Configuration Schema Versioning

### Problem

As Grove evolves, `grove.yaml` will gain new fields, change defaults, and deprecate old options. Without schema versioning, upgrading Grove can break existing configs silently or require manual migration.

### Solution

Add a `version` field to grove.yaml, a migration system that transforms configs between versions, and validation against versioned schemas.

### Version Field

```yaml
version: 2  # integer, required starting now
workspace:
  name: "My Grove"
trees:
  # ...
```

Current configs without `version` are treated as version 1.

### Migration System

Create `src/broker/config-migrations.ts`:

```typescript
interface Migration {
  from: number;
  to: number;
  description: string;
  migrate(config: any): any;
}

const migrations: Migration[] = [
  {
    from: 1, to: 2,
    description: "Add adapter field to settings, normalize tunnel config",
    migrate(config) {
      config.version = 2;
      config.settings.default_adapter ??= "claude-code";
      // ... other transforms
      return config;
    },
  },
];

/** Run all necessary migrations from current version to latest */
export function migrateConfig(config: any): { config: any; applied: string[] };

/** Get the latest schema version */
export function latestVersion(): number;

/** Validate config against its version's schema */
export function validateVersion(config: any): ValidationResult;
```

### CLI Command

```
grove config migrate          # Migrate grove.yaml to latest version (with backup)
grove config validate         # Validate current config
grove config version          # Show current and latest version
```

**Behavior:**
- `grove config migrate` creates `grove.yaml.bak` before writing
- Shows diff of what changed
- Requires confirmation for destructive changes

### Auto-Migration on Startup

When the broker starts:
1. Load grove.yaml
2. If `version` < latest, log warning: "Config is version {n}, latest is {m}. Run `grove config migrate` to upgrade."
3. Apply migrations in-memory (don't write to disk automatically — user should control this)
4. Validate migrated config

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/broker/config-migrations.ts` | Migration definitions + runner |
| Create | `src/broker/config-schema.ts` | Per-version validation schemas |
| Create | `src/cli/commands/config.ts` | Config CLI subcommands |
| Modify | `src/broker/config.ts` | Add version detection, auto-migration on load, validation |
| Modify | `src/shared/types.ts` | Add `version` to GroveConfig |
| Modify | `src/cli/index.ts` | Register config subcommand |

### Acceptance Criteria

- [ ] Configs without version field treated as v1
- [ ] Migrations transform v1 → v2 (and future versions)
- [ ] `grove config migrate` backs up and upgrades grove.yaml
- [ ] `grove config validate` reports errors/warnings
- [ ] Broker logs warning on startup if config version is old
- [ ] In-memory migration doesn't write to disk without user action
- [ ] Unit tests for each migration transform
- [ ] Round-trip test: write → migrate → validate → load

---

## T9: Observability Dashboard Enhancement

### Problem

The current dashboard shows aggregate metrics (cost by tree, daily spend, gate analytics) but lacks per-worker visibility. Users can't see what individual workers are doing over time, how long each pipeline step takes, or where bottlenecks occur.

### Solution

Enhance the dashboard with per-worker activity timelines, task execution flame graphs, and trend visualizations — all powered by SAP events from T2.

### New Dashboard Tabs/Sections

**Activity Timeline (new tab):**

A horizontal timeline showing all active and recent workers:

```
┌─ Activity Timeline ──────────────────────────────┐
│ W-042  [████████████·····] implement (2m 15s)    │
│ W-043  [████·] plan (45s)                         │
│ W-041  [██████████████████] completed (4m 30s)   │
│                                                   │
│ ──── 10:30 ─── 10:31 ─── 10:32 ─── 10:33 ────  │
└───────────────────────────────────────────────────┘
```

- Bars colored by step type (blue=worker, orange=gate, green=merge, purple=review)
- Click bar to expand into activity detail
- Real-time: active tasks animate as they progress
- Zoom: 1h / 4h / 24h / 7d ranges

**Task Flame Graph (in task detail):**

Wall-clock breakdown of how a task spent its time:

```
┌─ Task W-042 Breakdown ────────────────────────────┐
│ plan      [████] 45s                               │
│ implement [█████████████████████] 3m 20s           │
│   ├─ reading (12 files)     [███] 25s              │
│   ├─ thinking               [████] 40s             │
│   ├─ editing (8 files)      [████████] 1m 15s     │
│   └─ testing                [████] 45s             │
│ evaluate  [██] 15s                                 │
│ merge     [█] 10s                                  │
│ Total: 4m 30s | Cost: $1.23                        │
└────────────────────────────────────────────────────┘
```

Requires SAP events (agent:tool_use, agent:thinking) to compute time-in-activity.

**Worker Utilization Chart:**

Shows how many workers are active over time vs max_workers capacity:

```
workers │  ▃▃▅▅▅▅▇▇▇▇▅▅▃▃▁▁▃▃▅▅▇▇▅▅
   5/5  │──────────────────────────────
        └── 10:00 ─── 11:00 ─── 12:00
```

**Gate Trend Lines:**

Pass rate over time (rolling 7-day):

```
100% │ ──●──●──●──●
     │        ╲
 80% │         ●──●──●
     │
 60% │
     └── Mon Tue Wed Thu Fri Sat Sun
```

**Event Log Viewer (new tab):**

Filterable table of all SAP events:

```
┌─ Event Log ──────────────────────────────────────┐
│ Filter: [task:W-042] [type:agent:*] [▼ 1h]     │
│                                                   │
│ 10:32:15  agent:tool_use   W-042  Read server.ts │
│ 10:32:16  agent:thinking   W-042  Analyzing...   │
│ 10:32:18  agent:tool_use   W-042  Grep handle... │
│ 10:32:19  gate:result      W-042  tests: pass    │
│ ... (scrollable, paginated)                       │
└───────────────────────────────────────────────────┘
```

### Backend Support

**New analytics queries in `src/broker/db.ts`:**

```typescript
/** Activity timeline data: task sessions with start/end/step/cost */
taskActivityTimeline(since: string): ActivityTimelineEntry[];

/** Per-task step durations (from events table) */
taskStepDurations(taskId: string): StepDuration[];

/** Worker utilization over time (bucketed by 5-minute intervals) */
workerUtilization(since: string): UtilizationBucket[];
```

**SAP event persistence:**

To support the event log viewer and flame graph, persist SAP events in the events table with structured detail:

```typescript
// In server.ts, when broadcasting SAP events, also persist to DB:
db.addEvent(event.taskId, event.agentId, event.type, JSON.stringify(event));
```

### API Endpoints

```
GET /api/analytics/timeline?since=1h     # Activity timeline data
GET /api/analytics/utilization?since=24h  # Worker utilization buckets
GET /api/analytics/task/:id/breakdown     # Per-task flame graph data
GET /api/analytics/events?task=X&type=Y&since=Z  # Filtered event log
```

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `web/src/components/ActivityTimeline.tsx` | Horizontal worker timeline |
| Create | `web/src/components/TaskBreakdown.tsx` | Flame graph / step breakdown |
| Create | `web/src/components/WorkerUtilization.tsx` | Capacity utilization chart |
| Create | `web/src/components/EventLogViewer.tsx` | Filterable event table |
| Modify | `web/src/components/Dashboard.tsx` | Add new tabs, wire components |
| Modify | `src/broker/db.ts` | New analytics queries |
| Modify | `src/broker/server.ts` | New analytics endpoints, SAP event persistence |

### Acceptance Criteria

- [ ] Activity timeline shows real-time worker bars with step colors
- [ ] Task breakdown computes time-in-activity from SAP events
- [ ] Worker utilization chart shows capacity over time
- [ ] Event log viewer supports filtering by task, type, time range
- [ ] All visualizations update in real-time via WebSocket
- [ ] Dashboard loads within 500ms for 1000+ events
- [ ] Gate trend lines show rolling pass rate

---

## T10: Interactive Seed Sessions (SAP-Native)

### Problem

T1 migrates seed sessions from tmux to the `--resume` subprocess pattern, making them functional on Windows. But the seed UX is still basic: linear conversation, no streaming of Claude's thinking, and the GUI shows messages only after they're complete.

### Solution

Redesign seed sessions as a first-class SAP feature with real-time response streaming, conversation branching, and a richer GUI experience.

### Real-time Response Streaming

T1's seed refactor delivers complete messages (wait for process exit, then broadcast response). T10 adds **streaming** — the user sees Claude's response token-by-token as it generates:

```typescript
// In monitorSeedSession():
// Instead of waiting for full response, emit partial content:
bus.emit("seed:chunk", { taskId, content: partialText, ts: Date.now() });
// ... as more chunks arrive ...
bus.emit("seed:chunk", { taskId, content: moreText, ts: Date.now() });
// When done:
bus.emit("seed:response", { taskId, content: fullText, ts: Date.now() });
```

**WebSocket protocol:**
```json
{ "type": "seed:chunk", "data": { "taskId": "W-003", "content": "Let me analyze...", "ts": 1234 } }
{ "type": "seed:chunk", "data": { "taskId": "W-003", "content": " the current auth", "ts": 1235 } }
{ "type": "seed:response", "data": { "taskId": "W-003", "content": "full response text", "ts": 1236 } }
```

### Conversation Branching

Allow users to "go back" and explore alternative design directions:

```typescript
interface SeedConversation {
  messages: ConversationMessage[];
  branches: Branch[];
  activeBranch: string;  // branch ID
}

interface Branch {
  id: string;
  parentMessageIndex: number;  // where this branch diverges
  messages: ConversationMessage[];
  label?: string;  // user-provided name like "JWT approach" vs "session approach"
}
```

**UI:** Fork button next to any assistant message. Creates a new branch from that point. Branch selector dropdown at top of seed chat. Each branch maintains its own Claude session ID.

### Enhanced Seed Chat UI

Upgrade `web/src/components/SeedChat.tsx` (or create new):

- **Streaming text:** Characters appear in real-time (typewriter effect from `seed:chunk` events)
- **Tool use display:** Show when Claude is reading files, searching code (from `agent:tool_use` events)
- **HTML mockups:** Render inline (existing feature, preserved)
- **Branch indicator:** Show which branch is active, allow switching
- **Progress indicator:** Show stage (exploring → clarifying → proposing → designing → complete)
- **Spec preview:** When seed_complete fires, show formatted spec with "Accept" / "Revise" buttons
- **Cost display:** Running cost of this seed session

### Multi-Turn Session Management

Enhance the --resume pattern from T1 with session health:

```typescript
// Track session state more granularly:
interface SeedSession {
  // ... T1 fields ...
  totalCost: number;
  messageCount: number;
  stage: "exploring" | "clarifying" | "proposing" | "designing" | "complete";
  branches: Map<string, { sessionId: string; messages: ConversationMessage[] }>;
  activeBranchId: string;
}
```

**Stage detection:** Parse Claude's output for stage indicators:
- "Let me explore the codebase" → exploring
- "I have a question" / multiple choice → clarifying
- "Here are 2-3 approaches" → proposing
- "Here's my recommended design" → designing
- `seed_complete` event → complete

### Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `web/src/components/SeedChat.tsx` | Enhanced seed chat with streaming + branches |
| Modify | `src/broker/seed-session.ts` | Add streaming chunks, branch management, stage detection |
| Modify | `src/shared/protocol.ts` | Add seed:chunk, seed:branch SAP events |
| Modify | `src/broker/server.ts` | Handle branch WebSocket actions |
| Modify | `src/broker/db.ts` | Store branches in seed conversation JSON |
| Modify | `web/src/App.tsx` | Wire new SeedChat component |

### Acceptance Criteria

- [ ] Claude's response streams token-by-token to the GUI
- [ ] User sees tool_use events as Claude explores the codebase
- [ ] Conversation branching works (fork, switch, label)
- [ ] Each branch maintains independent Claude session
- [ ] Stage indicator shows seed session progress
- [ ] Spec preview with Accept/Revise on completion
- [ ] Running cost displayed during session
- [ ] Multiple concurrent seed sessions work independently
- [ ] All seed features work on Windows (no tmux)

---

## Implementation Notes

### Shared Patterns

- **SAP events** (T1) are the foundation. T2, T3, T9, T10 all depend on them.
- **Adapter interface** (T5) is consumed by T4's `adapter:register` hook.
- **DAG algorithms** (T7) are pure functions — easy to test, no side effects.
- **Config migrations** (T8) are independent — can be built anytime.

### Risk Areas

1. **Claude Code --resume reliability** (T1, T10): If session resume fails or loses context, seed sessions degrade. Mitigation: fall back to new session with conversation history in system prompt.
2. **Non-Claude adapter output formats** (T5): Each CLI has different JSON output. Mitigation: adapters return normalized SAP events; unknown output logged but not fatal.
3. **ReactFlow bundle size** (T7): ~150KB gzipped. Mitigation: lazy-load the DAG editor tab.
4. **SAP event volume** (T2, T9): A busy worker emits hundreds of events per minute. Mitigation: batched WebSocket broadcast (100ms), ring buffer (100 events), DB persistence only for gate/lifecycle events (not every tool_use).

### Estimated Scope

| Task | New Files | Modified Files | New Lines (est) | Tests (est) |
|------|-----------|----------------|-----------------|-------------|
| T1 | 1 | 11 | ~400 | ~25 |
| T2 | 1 | 6 | ~300 | ~15 |
| T3 | 6 | 1 | ~600 | ~40 |
| T4 | 4 | 7 | ~500 | ~20 |
| T5 | 6 | 8 | ~600 | ~25 |
| T6 | 1 | 7 | ~300 | ~15 |
| T7 | 2 | 7 | ~700 | ~20 |
| T8 | 3 | 4 | ~300 | ~10 |
| T9 | 4 | 3 | ~600 | ~10 |
| T10 | 1 | 5 | ~500 | ~15 |
