# Grove

**AI development orchestrator.** Install, run, get a URL. Manage your coding agents from anywhere.

Grove gives you a conversational orchestrator that plans work, decomposes tasks across repos, and delegates to Claude Code workers — all observable through a real-time web GUI accessible via secure tunnel.

## Quick Start

```bash
# Install
brew install grove
# or: npm install -g @grove-ai/cli

# Initialize
grove init

# Add your repos (trees)
grove tree add ~/code/api-server
grove tree add ~/code/frontend

# Start everything
grove up
```

On `grove up`, you get:

```
  ✓ Broker started (PID 12345)
  ✓ Orchestrator spawned in tmux:grove
  ✓ Tunnel active

  Local:   http://localhost:49231
  Remote:  https://grove-a1b2c3.trycloudflare.com
  Token:   k8m2x9p4...
  tmux:    tmux attach -t grove
```

Open the URL in a browser. Chat with the orchestrator. Watch workers implement tasks in real-time.

## How It Works

```
You ─── Browser (GUI) ─── Tunnel ───┐
  │                                   │
  ├── tmux attach ──────────────┐     │
  │                              │     │
  └── grove CLI ────────────┐    │     │
                             │    │     │
                             ▼    ▼     ▼
                   ┌──────────────────────────┐
                   │    Broker (Bun process)    │
                   │                           │
                   │  Web+WS · SQLite · tmux   │
                   │  Monitor · Merge Manager  │
                   └───────────┬───────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                   ▼
      Orchestrator        Worker(s)           Evaluator
      (Claude Code)     (Claude Code)       (Claude Code)
      persistent        ephemeral           on-demand
```

**Broker** — lightweight Bun process managing tmux, HTTP/WebSocket server, SQLite, tunnel, health/cost monitoring, and merge queue. It's infrastructure, not intelligence.

**Orchestrator** — Claude Code session you converse with. Plans work, decomposes cross-repo tasks, delegates to workers. Read-only tools.

**Workers** — ephemeral Claude Code sessions. Each gets a git worktree, sandboxed environment, and focused task prompt. Full toolset within worktree boundary.

**Evaluator** — spawned after a worker completes. Runs quality gates (commits, tests, lint, diff size). Separate from the worker per the GAN insight: models are bad critics of their own output.

## Concepts

### Trees

Trees are repos under Grove management. Each tree wraps a git repo.

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
```

### Paths

Paths are workflow templates. Different task types follow different paths.

```yaml
paths:
  development:    # plan → implement → evaluate → merge
  research:       # plan → research → report
  content:        # plan → implement → evaluate → publish
```

### Task Lifecycle

```
planned → ready → running → done → evaluating → merged
                    ↓                              ↓
                  paused                       ci_failed → retry
                    ↓
                  failed
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `grove init` | Initialize ~/.grove |
| `grove up` | Start broker + orchestrator + tunnel |
| `grove down` | Stop everything |
| `grove status` | System status |
| `grove trees` | List trees |
| `grove tree add <path>` | Add a repo as a tree |
| `grove tasks` | List tasks |
| `grove task add "title"` | Create a task |
| `grove chat "message"` | Message the orchestrator |
| `grove cost` | Spend breakdown |

## Web GUI

3-panel layout:
- **Left**: Trees, system status, navigation
- **Center**: Task list with live activity, pipeline progress, expandable detail
- **Right**: Orchestrator chat

Everything updates in real-time via WebSocket.

## Requirements

- [Claude Code CLI](https://claude.ai/code) — the agent runtime
- [tmux](https://github.com/tmux/tmux) — session management
- [git](https://git-scm.com/) — version control
- [gh](https://cli.github.com/) — GitHub CLI for PRs

## Configuration

See `grove.yaml.example` for all options. Key sections:

- **trees** — repos under management
- **paths** — workflow templates
- **budgets** — cost controls (per task, daily, weekly)
- **server** — port configuration
- **tunnel** — remote access provider
- **settings** — max workers, stall timeout, retry limits

## Security

- Auth token generated on first `grove up`, stored at `~/.grove/auth.token`
- Web GUI requires token (stored in browser localStorage)
- Workers sandboxed to their worktree via guard hooks
- No `git push` allowed from workers — broker handles merges

## License

MIT
