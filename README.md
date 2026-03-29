# Grove

**Conversational AI development orchestrator.** Install, run, get a URL. Manage your coding agents from anywhere.

Grove gives you a head agent (the orchestrator) that you chat with to plan work, decompose tasks across repos, and delegate to Claude Code workers — all observable through a real-time web GUI accessible via secure tunnel.

> **Status:** Alpha (v3.0.0-alpha.1). Core infrastructure works. Actively iterating on the orchestrator prompt and worker sandbox.

## Install

```bash
# One-liner (macOS / Linux)
curl -fsSL https://grove.cloud/install.sh | bash

# Or with Homebrew (macOS)
brew install bpamiri/grove/grove

# Or build from source
git clone https://github.com/bpamiri/grove.git
cd grove && bun install && cd web && bun install && cd .. && bun run build
```

## Quick Start

```bash
# Initialize
grove init

# Add your repos
grove tree add ~/code/my-project

# Start everything
grove up
```

On `grove up`:

```
  ✓ Broker started (PID 12345)
  ✓ Orchestrator spawned
  ✓ Tunnel active

  Local:   http://localhost:49231
  Remote:  https://my-grove.grove.cloud
  Token:   k8m2x9p4...
```

Open the URL in a browser or on your phone. Chat with the orchestrator. Watch workers implement tasks in real-time.

## Architecture

```
You ─── Browser (GUI) ─── grove.cloud ──┐
  │                                      │
  └── grove CLI ─────────────────┐       │
                                  │       │
                                  ▼       ▼
                   ┌───────────────────────────────┐
                   │      Broker (Bun process)      │
                   │                                │
                   │  Web+WS · SQLite · JSONL pipes │
                   │  Monitor · Notifications       │
                   │  Merge Manager · Analytics     │
                   └───────────┬────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                   ▼
      Orchestrator        Worker(s)           Evaluator
      (Claude Code)     (Claude Code)       (Claude Code)
      pipe-based        ephemeral           on-demand
      stdin/stdout      worktrees           quality gates
```

The system separates **infrastructure** from **intelligence**:

- **Broker** — Bun process managing HTTP+WebSocket server, SQLite state, tunnel, health/cost monitoring, notifications, and merge queue. Stable, lightweight, never makes decisions.
- **Orchestrator** — Claude Code session communicating via structured JSONL pipes (stdin/stdout). You chat with it to plan and delegate. It has read-only access to all your repos.
- **Workers** — Ephemeral Claude Code sessions. Each gets an isolated git worktree with a sandboxed environment. Full toolset within the worktree boundary.
- **Evaluator** — Spawned after a worker completes. Runs quality gates (commits, tests, lint, diff size) with pre-gate rebase. Separate agent because models are poor critics of their own output.
- **Monitor** — Broker-native health checks: PID liveness, stall detection, cost tracking, auto-restart.
- **Merge Manager** — Broker-native PR lifecycle: push, create PR, watch CI, merge on green, close linked issues. Sequential per-repo to prevent conflicts.
- **Notifications** — Pluggable alerts (Slack, system, webhook) for task completion, gate failures, budget events, and crashes.

## Concepts

### Trees

Trees are repos under Grove management. A grove is a collection of trees.

```yaml
# ~/.grove/grove.yaml
trees:
  api-server:
    path: ~/code/api-server
    github: myorg/api-server
    branch_prefix: grove/
    quality_gates:
      tests: true
      lint: true

  frontend:
    path: ~/code/frontend
    github: myorg/frontend
```

### Paths

Paths are workflow templates. Different task types follow different pipelines.

```yaml
paths:
  development:              # plan → implement → evaluate → merge
    steps: [plan, implement, evaluate, merge]

  research:                 # plan → research → report (no code changes)
    steps: [plan, research, report]

  content:                  # plan → implement → evaluate → publish
    steps: [plan, implement, evaluate, publish]
```

Built-in paths ship with Grove. Create custom ones in `grove.yaml`.

### Task Lifecycle

```
planned → ready → running → done → evaluating → merged
                    ↓                     ↓
                  paused              ci_failed → retry
                    ↓
                  failed
```

- Hard gate failure (no commits, tests fail) → auto-retry up to `max_retries`
- Soft gate failure (lint warnings, diff too large) → pass through with warnings
- CI failure → orchestrator decides: retry worker or escalate to user

## Web GUI

Three-panel layout served by the broker, plus an analytics dashboard:

- **Left sidebar** — Tree list, system status (broker, orchestrator, workers, cost), navigation to Tasks/Dashboard/Settings
- **Center** — Task cards with live status, activity stream, pipeline progress, expandable detail with gate results and file diffs
- **Right** — Orchestrator chat with message history
- **Dashboard** — Timeline view (Gantt-style task bars), cost-by-tree breakdown, quality gate pass/fail rates, retry statistics

Real-time updates via WebSocket. Accessible remotely via grove.cloud tunnel.

## CLI

| Command | Purpose |
|---------|---------|
| `grove init` | Initialize `~/.grove/` with config and database |
| `grove up` | Start broker, orchestrator, and tunnel |
| `grove down` | Graceful shutdown |
| `grove status` | Broker health, workers, costs |
| `grove trees` | List configured trees |
| `grove tree add <path>` | Add a repo (auto-detects GitHub remote) |
| `grove tasks` | List tasks with filtering |
| `grove task add "title"` | Create a new task |
| `grove chat "message"` | Message the orchestrator |
| `grove cost` | Spend breakdown (today, week) |

Most interaction happens through the orchestrator — via the GUI chat or `grove chat`.

## Requirements

- **[Bun](https://bun.sh/)** >= 1.0 — runtime and build tool
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — the agent runtime (requires Claude subscription)
- **[tmux](https://github.com/tmux/tmux)** — terminal multiplexer for seed (brainstorming) sessions
- **[git](https://git-scm.com/)** — version control and worktree isolation
- **[gh](https://cli.github.com/)** — GitHub CLI for PR management
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)** — tunnel for remote access (optional)

## Configuration

See [`grove.yaml.example`](grove.yaml.example) for all options:

- **trees** — repos under management
- **paths** — workflow templates (built-ins + custom)
- **budgets** — cost controls (per task: $5, daily: $25, weekly: $100 defaults)
- **server** — port (`auto` picks a random available port)
- **tunnel** — provider (cloudflare), auth (token), optional custom domain
- **settings** — max workers (5), stall timeout (5 min), retry limits (2)
- **notifications** — alert channels and event routing (see below)

### Notifications

Opt-in. Add a `notifications` section to `grove.yaml`:

```yaml
notifications:
  channels:
    slack:
      webhook_url: "https://hooks.slack.com/services/..."
    system:
      enabled: true     # macOS Notification Center / Linux notify-send
    webhook:
      url: "https://example.com/grove-events"
      secret: "hmac-secret"

  routes:
    task_completed: [slack]
    task_failed: [slack, system]
    gate_failed: [slack, system]
    pr_merged: [slack]
    budget_warning: [system]
    budget_exceeded: [slack, system]
    orchestrator_crashed: [slack, system]

  quiet_hours:
    start: "22:00"
    end: "07:00"
```

Channels: **Slack** (Block Kit formatted messages), **System** (native OS notifications with quiet hours), **Webhook** (JSON payload with HMAC-SHA256 signature). Rate limited to 1 notification per event type per 60 seconds.

## Security

- Random auth token generated on first `grove up`, stored at `~/.grove/auth.token`
- Web GUI requires the token (entered once, persisted in browser)
- Workers sandboxed to their worktree via PreToolUse guard hooks
- Dangerous commands blocked (`git push`, `sudo`, `rm -rf /`)
- File writes restricted to the worktree boundary
- No `git push` from workers — the merge manager handles that

## Influences

- **[Gas Town](https://github.com/steveyegge/gastown)** (Steve Yegge) — multi-agent orchestration, rig/tree concept, open-source distribution model
- **[Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)** — Planner/Generator/Evaluator pattern, GAN-inspired separation of building from judging
- **Claude Code** — native capabilities (hooks, MCP, permissions) leveraged rather than rebuilt

## Development

```bash
# Run from source (no build step)
bun run dev -- help

# Run tests
bun run test

# Build binary + frontend
bun run build

# Type check
bunx tsc --noEmit
```

### Project Structure

```
src/
  agents/          Orchestrator (JSONL pipes), worker, evaluator, stream parser
  broker/          DB, config, HTTP+WS server, tmux, event bus, dispatch, pipeline
  cli/             Entry point + 9 command files
  engine/          Step engine + path normalization
  merge/           GitHub CLI wrapper + merge queue manager
  monitor/         Health checks + cost tracking
  notifications/   Dispatcher + Slack, system, webhook channels
  shared/          Types, worktree, sandbox (guard hooks + overlays)
  tunnel/          Cloudflare tunnel provider
web/
  src/             React + Vite + Tailwind SPA (tasks, dashboard, chat, settings)
worker/
  src/             Cloudflare Worker — grove.cloud reverse proxy
tests/             123 tests across 15 files
scripts/
  install.sh       curl-pipe installer
.github/workflows/
  test.yml         CI — runs bun test on push/PR
  release.yml      Multi-platform release (macOS arm64/x64, Linux x64)
```

## License

MIT
