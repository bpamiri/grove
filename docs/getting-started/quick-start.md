# Quick Start

## Initialize Grove

```bash
grove init
```

Creates `~/.grove/` with:
- `grove.yaml` — configuration file
- `grove.db` — SQLite database for task state
- `logs/` — session logs

## Add Your Repositories

Grove manages repos as "trees" — a grove is a collection of trees.

```bash
grove tree add ~/code/my-project
```

Auto-detects the GitHub remote and registers the tree. Add multiple repos:

```bash
grove tree add ~/code/api-server
grove tree add ~/code/frontend
grove trees   # List all trees
```

Options:
- `--github org/repo` — override remote detection
- `--name my-name` — override auto-generated ID

## Start Grove

```bash
grove up
```

```
  Grove v0.1.29

  Broker started (PID 12345)
  Orchestrator ready
  Tunnel active

  Local:   http://localhost:49231
  Tunnel:  https://random.trycloudflare.com
  Remote:  https://my-grove.grove.cloud        (if registered)
```

Two ways to interact:

1. **Web GUI** — open the Local URL in a browser
2. **CLI** — `grove chat "message"` from any terminal

## Chat with the Orchestrator

```bash
grove chat "Add error handling to the auth module in api-server"
```

Or use the web GUI's chat panel. The orchestrator plans the work, decomposes it into tasks, and delegates to workers.

## Seed a Task

Use the brainstorming workflow to create well-defined tasks:

```bash
grove chat "I want to add rate limiting to the API"
```

The orchestrator will brainstorm the approach, propose a plan, and break it into tasks. Approve the plan and workers pick up the tasks automatically. You can also seed tasks directly:

```bash
grove task add "Add rate limiting middleware"
```

## Dashboard

Open the web GUI (the Local URL from `grove up`) to see the real-time dashboard: task timeline, worker activity, cost breakdown, and gate pass/fail rates.

## Monitor Progress

```bash
grove status    # Broker health, workers, costs
grove tasks     # List all tasks with status
grove cost      # Spend breakdown
```

The web GUI shows real-time updates via WebSocket. Use the **Dashboard** view for analytics: task timeline, cost breakdown by tree, and gate pass/fail rates.

## Stop Grove

```bash
grove down
```

Gracefully stops the broker, orchestrator, workers, and tunnel.

## Next Steps

- [Configuration](../guides/configuration.md) — customize trees, paths, budgets, tunnel
- [CLI Reference](../guides/cli-reference.md) — all commands
- [Architecture](../guides/architecture.md) — how it all works, API reference
- [Task Management](../guides/task-management.md) — dependencies, batch dispatch, cancel/pause, resume at step
- [Custom Paths](../guides/custom-paths.md) — define custom pipelines with step types and transitions
- [GitHub Integration](../guides/github-integration.md) — issue sync, PR lifecycle, CI monitoring
- [Web GUI](../guides/web-gui.md) — seeding, filters, dashboard, activity indicators
