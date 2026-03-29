# Grove

**Conversational AI development orchestrator.** Install, run, get a URL. Manage your coding agents from anywhere.

Grove gives you a head agent (the orchestrator) that you chat with to plan work, decompose tasks across repos, and delegate to Claude Code workers — all observable through a real-time web GUI accessible via secure tunnel.

> **Status:** Alpha (v3.0.0-alpha.0). Core infrastructure works. Actively iterating on the orchestrator prompt and worker sandbox.

## Quick Start

```bash
# Clone and build
git clone https://github.com/bpamiri/grove.git
cd grove
bun install
cd web && bun install && cd ..
bun run build

# Initialize
bin/grove init

# Add your repos
bin/grove tree add ~/code/my-project

# Start everything
bin/grove up
```

On `grove up`:

```
  ✓ Broker started (PID 12345)
  ✓ Orchestrator spawned in tmux:grove
  ✓ Tunnel active

  Local:   http://localhost:49231
  Remote:  https://grove-a1b2c3.trycloudflare.com
  Token:   k8m2x9p4...
  tmux:    tmux attach -t grove
```

Open the URL in a browser or on your phone. Chat with the orchestrator. Watch workers implement tasks in real-time.

## Architecture

```
You ─── Browser (GUI) ─── Tunnel ───┐
  │                                 │
  ├── tmux attach ──────────────┐   │
  │                             │   │
  └── grove CLI ────────────┐   │   │
                            │   │   │
                            ▼   ▼   ▼
                   ┌──────────────────────────┐
                   │    Broker (Bun process)  │
                   │                          │
                   │  Web+WS · SQLite · tmux  │
                   │  Monitor · Merge Manager │
                   └───────────┬──────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
      Orchestrator        Worker(s)           Evaluator
      (Claude Code)     (Claude Code)       (Claude Code)
      persistent        ephemeral           on-demand
```

The system separates **infrastructure** from **intelligence**:

- **Broker** — Bun process managing tmux sessions, HTTP+WebSocket server, SQLite state, tunnel, health/cost monitoring, and merge queue. Stable, lightweight, never makes decisions.
- **Orchestrator** — Interactive Claude Code session in tmux. You chat with it to plan and delegate. It has read-only access to all your repos.
- **Workers** — Ephemeral Claude Code sessions. Each gets an isolated git worktree with a sandboxed environment. Full toolset within the worktree boundary.
- **Evaluator** — Spawned after a worker completes. Runs quality gates (commits, tests, lint, diff size). Separate agent because models are poor critics of their own output.
- **Monitor** — Broker-native health checks: PID liveness, stall detection, cost tracking, auto-restart.
- **Merge Manager** — Broker-native PR lifecycle: push, create PR, watch CI, merge on green. Sequential per-repo to prevent conflicts.

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

Three-panel layout served by the broker:

- **Left sidebar** — Tree list, system status (broker, orchestrator, workers, cost), navigation
- **Center** — Task cards with live status, activity stream, pipeline progress, expandable detail with gate results and file diffs
- **Right** — Orchestrator chat with message history, relayed to/from the tmux session

Real-time updates via WebSocket. Accessible remotely through the tunnel.

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

Most interaction happens through the orchestrator — via the GUI chat, tmux, or `grove chat`.

## Requirements

- **[Bun](https://bun.sh/)** >= 1.0 — runtime and build tool
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — the agent runtime (requires Claude subscription)
- **[tmux](https://github.com/tmux/tmux)** — terminal multiplexer for agent sessions
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
  agents/       Orchestrator, worker, evaluator, stream parser
  broker/       DB, config, HTTP+WS server, tmux, event bus, dispatch, pipeline
  cli/          Entry point + 9 command files
  merge/        GitHub CLI wrapper + merge queue manager
  monitor/      Health checks + cost tracking
  shared/       Types, worktree, sandbox (guard hooks + overlays)
  tunnel/       Cloudflare tunnel provider
web/
  src/          React + Vite + Tailwind SPA
tests/
  broker/       Unit tests (37 tests)
```

## License

MIT
