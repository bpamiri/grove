# Grove

**Conversational AI development orchestrator.** Manage your coding agents from anywhere through a real-time web GUI.

Grove gives you a head agent (the orchestrator) that you chat with to plan work, decompose tasks across repos, and delegate to Claude Code workers — all observable through a web GUI accessible via secure tunnel.

> **Status:** Alpha (![GitHub release](https://img.shields.io/github/v/release/bpamiri/grove?label=latest)). Core infrastructure works. Actively iterating.

## Quick Start

```bash
# Install (macOS Apple Silicon)
curl -fsSL https://github.com/bpamiri/grove/releases/latest/download/grove-darwin-arm64.tar.gz | tar xz
chmod +x grove && sudo mv grove /usr/local/bin/

# Initialize and start
grove init
grove tree add ~/code/my-project
grove up
```

See [Installation](docs/getting-started/installation.md) for all platforms and build-from-source instructions.

## Architecture

```
You --- Browser (GUI) --- Tunnel ---+
  |                                  |
  +-- tmux attach ---------+         |
  |                         |        |
  +-- grove CLI -------+    |        |
                        |   |        |
                        v   v        v
              +---------------------------+
              |    Broker (Bun process)   |
              |                           |
              |  HTTP+WS . SQLite . tmux  |
              |  Monitor . Merge Manager  |
              +----------+----------------+
                         |
          +--------------+--------------+
          v              v              v
    Orchestrator     Worker(s)      Evaluator
    (Claude Code)  (Claude Code)  (Claude Code)
    persistent     ephemeral      on-demand
```

The system separates **infrastructure** from **intelligence**:

- **Broker** — Bun process managing HTTP+WebSocket server, SQLite state, tmux sessions, tunnel, health/cost monitoring, merge queue, and notifications. Stable, lightweight, never makes decisions.
- **Orchestrator** — Persistent Claude Code session. You chat with it to plan and delegate.
- **Workers** — Ephemeral Claude Code sessions in isolated git worktrees with sandboxed guard hooks.
- **Evaluator** — Runs quality gates (tests, lint, diff size) on worker output. Separate agent because models are poor critics of their own output.

## CLI

| Command | Purpose |
|---------|---------|
| `grove init` | Initialize `~/.grove/` |
| `grove up` | Start broker + orchestrator + tunnel |
| `grove down` | Graceful shutdown |
| `grove status` | Broker health, workers, costs |
| `grove trees` | List configured trees (repos) |
| `grove tree add <path>` | Add a repo |
| `grove tasks` | List tasks |
| `grove task add "title"` | Create a task |
| `grove chat "message"` | Message the orchestrator |
| `grove cost` | Spend breakdown |
| `grove upgrade` | Update to latest version |

## Requirements

- **[Bun](https://bun.sh/)** >= 1.0
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)**
- **[tmux](https://github.com/tmux/tmux)**
- **[git](https://git-scm.com/)**
- **[gh](https://cli.github.com/)** (optional, for PR management)
- **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)** (optional, for remote access)

## Documentation

- **Getting Started**
  - [Installation](docs/getting-started/installation.md)
  - [Quick Start](docs/getting-started/quick-start.md)
  - [Upgrading](docs/getting-started/upgrading.md)
- **Guides**
  - [Configuration](docs/guides/configuration.md)
  - [Notifications](docs/guides/configuration.md#notifications) — Slack, system, and webhook alerts
  - [CLI Reference](docs/guides/cli-reference.md)
  - [Architecture](docs/guides/architecture.md)
  - [Security](docs/guides/security.md)

## Development

```bash
bun run dev -- help    # Run from source
bun run test           # Run tests (121 tests)
bun run build          # Build binary + frontend
```

## License

MIT
