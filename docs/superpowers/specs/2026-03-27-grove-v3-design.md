# Grove v3 — Design Specification

## Overview

Grove v3 is a conversational AI development orchestrator. Users install it, run `grove up`, and get a URL to manage AI coding agents from anywhere. It combines a tmux-based agent runtime with a web GUI and secure tunnel for remote access.

**Core thesis:** The developer's job is shifting from writing code to orchestrating agents. Grove makes that orchestration accessible, observable, and controllable — from a terminal, a browser, or a phone.

## Influences

- **Gas Town** (Steve Yegge): Rigs concept (→ "trees"), multi-agent roles, open-source distribution model
- **Anthropic harness design papers** (Nov 2025, March 2026): Planner → Generator → Evaluator pattern, GAN-inspired separation of building from judging, iterative simplification as models improve
- **Claude Code**: Channels, hooks, MCP, permissions — native capabilities to leverage, not rebuild
- **Grove v0.2**: SQLite state, git worktrees, quality gates, stream-json monitoring, budget tracking

## Architecture: Thin Broker

The system has two layers: a **broker** (infrastructure) and **agents** (intelligence).

```
┌────────────────────────────────────────────────────┐
│  grove up (Bun process) — the Broker               │
│                                                     │
│  HTTP+WS Server ◄─── Tunnel (cloudflared)          │
│       │                                             │
│  Event Bus ──── SQLite (WAL) ──── tmux Manager     │
│       │                                │            │
│  Monitor (health/cost)     Merge Manager (gh CLI)  │
└────────────────┬───────────────────────────────────┘
                 │ spawns & manages
    ┌────────────┼─────────────┐
    ▼            ▼             ▼
Orchestrator  Worker(s)    Evaluator
(Claude Code) (Claude Code) (Claude Code)
tmux pane 0   panes 1..N   on-demand
```

### Broker Responsibilities

1. **tmux session management** — create/destroy windows for agents
2. **Web server** — serve React GUI, handle WebSocket for real-time updates
3. **Tunnel** — spawn cloudflared for remote access (free, no account needed)
4. **SQLite** — own the database, handle all reads/writes
5. **Message relay** — bridge GUI ↔ orchestrator (WebSocket ↔ tmux stdin/stdout)
6. **Monitor** — watch PIDs, detect stalls, track costs (broker-native code, not Claude)
7. **Merge Manager** — create PRs, watch CI, merge on green (broker-native code, `gh` CLI)

### What the Broker Does NOT Do

- Make decisions about tasks
- Understand code or repos
- Plan, evaluate, or decompose work
- Generate prompts or reason about failures

### Communication Protocol

Agents communicate with the broker via two mechanisms:

1. **Workers and Evaluator** run as `claude -p "..." --output-format stream-json`, piped through the broker. The broker reads their stdout directly (JSON lines) and writes to their stdin if needed.
2. **Orchestrator** runs as an interactive Claude Code session in tmux. The broker communicates by:
   - **Reading:** Tailing the orchestrator's `--output-format stream-json` log file (same as v0.2's monitor)
   - **Writing:** Using `tmux send-keys` to inject user messages into the orchestrator's pane
   - The orchestrator's CLAUDE.md instructs it to emit structured JSON events via a designated convention (e.g., writing to a shared file or using a specific output format)

```
Worker → stdout JSON (piped) → Broker → SQLite + WebSocket → GUI
Orchestrator → log file (tailed) → Broker → SQLite + WebSocket → GUI
GUI → WebSocket → Broker → tmux send-keys → Orchestrator
CLI → Broker HTTP API → SQLite (or relay via tmux send-keys)
```

Event types:
```jsonl
{"type":"status","task":"W-042","msg":"Running tests..."}
{"type":"gate","task":"W-042","gate":"tests","result":"pass"}
{"type":"cost","task":"W-042","usd":0.45,"tokens":12000}
{"type":"done","task":"W-042","summary":"Fixed auth bug","pr":123}
{"type":"user_msg","from":"web","text":"What's the status?"}
{"type":"worker_event","task":"W-042","event":"gate_failed"}
```

## Agent Roles (5 Roles, 3 Claude Code)

### 1. Orchestrator (Claude Code — persistent)

The head agent you converse with. Plans work, decomposes cross-repo tasks, delegates to workers, responds to user questions.

- **Spawned by:** Broker on `grove up`
- **Lifetime:** Persistent — survives task cycles, auto-restarted on crash
- **Tools:** Read, Grep, Glob, Bash (read-only), WebSearch — NO Edit/Write
- **Input:** User messages (GUI/tmux), worker events, gate results
- **Output:** JSON events to broker (spawn_worker, task_update, user_response)

### 2. Workers (Claude Code — ephemeral)

Implementation agents. Each gets a git worktree, sandboxed Claude Code session, and focused task prompt.

- **Spawned by:** Broker on orchestrator request
- **Lifetime:** Task-scoped — exits on completion
- **Tools:** Full toolset within worktree boundary (Edit, Write, Bash, etc.)
- **Sandbox:** Guard hooks restrict file ops to worktree + /tmp
- **Context:** CLAUDE.md overlay with task description, repo context, session history

### 3. Evaluator (Claude Code — on-demand)

QA agent. Reviews the diff, runs tests, checks quality gates. Separate from the worker per the Anthropic GAN insight: "models are terrible critics of their own output."

- **Spawned by:** Broker when worker reports "done"
- **Lifetime:** Evaluation-scoped
- **Tools:** Read, Grep, Glob, Bash (tests/lint), Git — NO Edit/Write
- **Output:** pass/fail + detailed feedback as JSON event

### 4. Monitor (broker-native — always running)

Not a Claude Code session. Watches worker processes for health, detects stalls, tracks cost overruns.

- **Runs in:** Broker process
- **Interval:** Every 10-30 seconds
- **Checks:** PID alive, last activity time, cost vs budget, tmux pane status
- **Actions:** Emit events (stall_detected, budget_warning, worker_crashed)

### 5. Merge Manager (broker-native — event-driven)

Not a Claude Code session. Handles PR lifecycle via `gh` CLI.

- **Runs in:** Broker process
- **Flow:** Evaluator passes → create PR → watch CI → merge on green
- **CI failure:** Emits event to orchestrator, which decides (retry worker, escalate to user)
- **Queue:** Sequential per-tree to avoid merge conflicts

## Agent Interaction Flow

```
User: "Fix the auth bug in api-server and update the docs in docs-site"

  Orchestrator
  ├─ Decomposes into 2 tasks (api-server + docs-site)
  ├─ Emits: spawn_worker for W-01 (api-server)
  ├─ Emits: spawn_worker for W-02 (docs-site, depends on W-01)
  │
  Broker spawns Worker 1; Worker 2 waits on dependency
  │
  Worker 1 → implements fix → commits → emits "done"
  │
  Evaluator → reviews diff, runs tests → emits "eval_pass"
  │
  Merge Manager → creates PR → CI green → merges
  │
  Broker unblocks W-02 → spawns Worker 2
  │
  Worker 2 → updates docs → eval → merge
  │
  Orchestrator → "Both tasks complete. PRs merged."
```

## Trees & Paths

### Trees (repo containers)

Each tree wraps a git repo under Grove management.

```yaml
# grove.yaml
trees:
  api-server:
    path: ~/code/api-server
    github: myorg/api-server
    branch_prefix: grove/
    quality_gates:
      tests: true
      lint: true

  docs-site:
    path: ~/code/docs-site
    github: myorg/docs-site
    branch_prefix: grove/
    quality_gates:
      tests: false
```

### Paths (workflow templates)

Paths define the pipeline for different task types. Built-in paths ship with Grove; users can create custom ones.

```yaml
# Built-in paths
paths:
  development:
    description: Standard dev workflow with QA
    steps: [plan, implement, evaluate, merge]

  research:
    description: Research task — produces a report, no code changes
    steps: [plan, research, report]

  content:
    description: Documentation and content creation
    steps: [plan, implement, evaluate, publish]
```

The orchestrator picks the path based on task type. Users can override via `grove task add --path research`.

### Cross-Repo Tasks

A single task can span multiple trees. The orchestrator decomposes it into sub-tasks per tree, manages dependencies, and coordinates the execution order.

**UX model:** The user creates one task ("Fix auth and update docs"). The orchestrator creates sub-tasks (W-01 in api-server, W-02 in docs-site) linked to the parent. The GUI shows the parent task with expandable sub-tasks. Sub-tasks have their own status, cost, and workers. The parent task completes when all sub-tasks complete.

## Web GUI

React + Vite SPA served by the broker, connected via WebSocket for real-time updates.

### Layout: 3-Panel Design

- **Left sidebar:** Tree list with active worker counts, quick actions (new task, settings, costs), system status (broker health, worker count, daily spend)
- **Center panel:** Task list with filtering (all/active/done, per-tree). Each task is a card showing status, current activity, cost, timing. Click to expand into detail view.
- **Right panel:** Orchestrator chat. Messages relay to/from the tmux session. Full conversation history persisted in SQLite.

### Task Detail View (expanded card)

- Status bar: status, tree, path, cost, time, branch
- Pipeline progress: visual step tracker (plan → implement → evaluate → merge)
- Live activity stream: real-time log of what the worker is doing (reading, editing, running tests)
- Files modified: list with diff line counts
- Gate results: post-evaluation quality gate outcomes
- Actions: pause, message worker, view diff, cancel

### Per-Tree View

Click a tree in the sidebar to filter center panel:
- All tasks for that tree (active, queued, completed)
- Active workers and status
- Recent PRs and merge history
- Cost totals
- Tree-specific settings

### Full Remote Control

Everything available in the CLI is available in the GUI: create tasks, manage trees, configure paths, approve/reject evaluations, view costs, adjust settings.

## Tunnel & Remote Access

### Default: Free Cloudflare Quick Tunnels

```
$ grove up
  ✓ Broker started on :54231       # random available port
  ✓ Orchestrator spawned in tmux:grove
  ✓ Tunnel active

  Local:   http://localhost:54231
  Remote:  https://grove-a1b2c3.trycloudflare.com
  tmux:    tmux attach -t grove
```

- `grove up` spawns `cloudflared tunnel --url http://localhost:{port}`
- Cloudflare assigns a random `*.trycloudflare.com` URL
- No DNS config, no firewall rules, no account required
- The broker picks a random available port (not hardcoded) and persists it to `~/.grove/broker.json`

### Security

- On first `grove up`, generates a random auth token stored in `~/.grove/auth.token`
- Web GUI requires the token (entered once, stored in browser localStorage)
- Token displayed in terminal output for user to copy

### Configuration

```yaml
# grove.yaml
server:
  port: auto              # default: random available port
  # port: 8432            # pin a specific port

tunnel:
  provider: cloudflare    # default, free
  # provider: bore        # alternative
  # provider: ngrok       # alternative, requires account
  auth: token             # default
  # auth: none            # local-only use
  # domain: grove.myco.com  # persistent (requires cloudflare account)
```

## Data Model

SQLite with WAL mode. Clean slate, informed by v0.2 patterns.

### Tables

**trees** — repos under management
- id (slug), name, path, github, branch_prefix, config (JSON), created_at

**tasks** — work items
- id, tree_id (FK), parent_task_id (FK, nullable — for cross-repo sub-tasks)
- title, description, status, path_name, priority
- depends_on, branch, worktree_path, pr_url, pr_number
- cost_usd, tokens_used, gate_results (JSON)
- session_summary, files_modified, retry_count, max_retries
- created_at, started_at, completed_at

**sessions** — one per agent spawn
- id, task_id (FK), role (worker/evaluator/orchestrator)
- pid, tmux_pane, cost_usd, tokens_used, status, log_path
- started_at, ended_at

**events** — audit trail
- id, task_id, session_id, event_type, summary, detail, created_at

**messages** — chat persistence
- id, source (user/orchestrator/worker/system), channel (main/W-042/etc)
- content, created_at

### Task Statuses

```
planned → ready → running → done → completed
                    ↓         ↓
                  paused    evaluating → merged
                    ↓                     ↓
                  failed              ci_failed → running (retry)
```

## Tech Stack & Distribution

### Stack

- **Runtime:** Bun (TypeScript compilation, built-in SQLite, HTTP server, subprocess management)
- **Backend:** Bun HTTP + WebSocket server (broker)
- **Frontend:** React + Vite + Tailwind (bundled into binary)
- **Database:** bun:sqlite with WAL mode
- **Agents:** Claude Code CLI sessions in tmux
- **Tunnel:** cloudflared (spawned as subprocess)
- **Git integration:** `gh` CLI for PRs, native git for worktrees

### Distribution

```
brew install grove                    # primary
npm install -g @grove-ai/cli         # fallback
curl -fsSL grove.dev/install | sh    # script
```

Bun compiles to a single binary (~50MB). Frontend assets embedded at build time. Zero runtime dependencies beyond:
- **Claude Code CLI** (required — the agent runtime)
- **tmux** (required — session management)
- **git** (required — worktrees, version control)
- **gh** (required — PR management)

### Open Source

MIT license. GitHub repo. Users clone, build, or install via package manager. The project ships with sensible defaults — `grove init` asks minimal questions, `grove up` just works.

## CLI Commands

Simplified from v0.2's 33 commands. Focused on the essential operations:

| Command | Purpose |
|---------|---------|
| `grove init` | Initialize ~/.grove, create config |
| `grove up` | Start broker + orchestrator + tunnel |
| `grove down` | Stop everything gracefully |
| `grove status` | Show system status (broker, workers, tunnel) |
| `grove trees` | List configured trees |
| `grove tree add <path>` | Add a repo as a tree |
| `grove paths` | List workflow templates |
| `grove task add "<title>"` | Create a task (orchestrator decomposes if needed) |
| `grove tasks` | List tasks with filtering |
| `grove chat "<message>"` | Send a message to the orchestrator |
| `grove logs [task]` | View event log / worker output |
| `grove cost` | Spend breakdown |

Most interaction happens through the orchestrator chat (terminal or GUI), not individual CLI commands.

## Resolved Design Decisions

1. **Orchestrator persistence:** Session rotation (shift handoff). The broker detects high context usage, gracefully stops the orchestrator, and starts a new session with a context summary injected from the previous one. SQLite + messages table provides the persistent state.
2. **Concurrent worker limit:** Configurable, default 5. Set via `grove.yaml` under `settings.max_workers`.
3. **Tunnel domain:** `grove.cloud` (purchased, Cloudflare-managed). Users get URLs like `abc123.grove.cloud`.
4. **User model:** Single-user. One person per Grove instance. Auth token prevents unauthorized tunnel access.
5. **Frontend bundling:** Embedded in the Bun binary. Vite builds to static files, Bun embeds at compile time. Single binary serves everything.
6. **Name:** Grove. Final.
