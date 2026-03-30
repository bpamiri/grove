# Architecture

## Overview

Grove separates **infrastructure** from **intelligence**. The broker handles all infrastructure (HTTP, database, tunnels, process management) while Claude Code agents handle all decision-making.

```
You --- Browser (GUI) --- Tunnel ---+
  |                                  |
  +-- tmux attach ---------+        |
  |                         |        |
  +-- grove CLI -------+    |        |
                        |    |        |
                        v    v        v
              +---------------------------+
              |    Broker (Bun process)    |
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

## Components

### Broker

The central Bun process. Lightweight, stable, never makes decisions. Manages:

- **HTTP + WebSocket server** — serves the web GUI, REST API (`/api/*`), and real-time updates
- **SQLite database** — task state, tree config, events, messages (via `bun:sqlite`)
- **tmux sessions** — orchestrator and worker panes
- **Step engine** — drives tasks through configurable pipelines (plan -> implement -> evaluate -> merge)
- **Dispatch queue** — manages concurrent worker slots (default: 5)
- **Health monitor** — detects stalled workers via PID liveness checks and stall timeouts
- **Cost monitor** — tracks Claude API spend against per-task, daily, and weekly budgets
- **Merge manager** — pushes branches, creates PRs, watches CI, merges on green (sequential per-repo)
- **Tunnel** — optional Cloudflare quick tunnel for remote access

State persisted to `~/.grove/broker.json` (PID, port, URLs) and `~/.grove/grove.db` (tasks, trees, events).

### Orchestrator

A persistent Claude Code session running in tmux. You chat with it to:
- Plan and decompose work across repos
- Create and prioritize tasks
- Review worker output and make decisions

The orchestrator has read-only awareness of all configured trees. It communicates with the broker via structured JSONL events on stdout.

### Workers

Ephemeral Claude Code sessions. Each worker:
- Gets an isolated git worktree (branch from the tree's default branch)
- Runs in a sandboxed environment with guard hooks
- Executes one pipeline step (plan, implement, etc.)
- Commits changes and reports back
- Is killed after completing its step

Workers cannot push to remote. The merge manager handles that.

### Evaluator

Spawned after a worker completes. Runs quality gates:
- **Commits** — checks for conventional commit format
- **Tests** — runs the tree's test command
- **Lint** — runs the tree's lint command
- **Diff size** — rejects changes that are too large or too small

Separate from the worker because models are poor critics of their own output.

Gate results: pass (advance to next step), fail (retry worker up to `max_retries`), or skip (soft warnings pass through).

## Data Flow

1. You create a task (via GUI, CLI, or orchestrator)
2. The step engine picks the task's path (e.g., `development`)
3. Dispatch assigns the first step to an available worker slot
4. Worker executes in an isolated worktree, commits, reports completion
5. Evaluator runs quality gates on the worker's output
6. If gates pass, the step engine advances to the next step
7. Merge manager pushes the branch, creates a PR, monitors CI
8. On CI green, the PR is merged and the task is marked complete

## Web GUI

Three-panel layout served by the broker at `http://localhost:{port}`:

- **Left sidebar** — tree list, system status, navigation
- **Center** — task cards with live status, activity stream, pipeline progress
- **Right** — orchestrator chat

Real-time updates via WebSocket. Accessible remotely through the tunnel with token authentication.

## Process Tree

```
grove up (foreground)
  +-- Bun HTTP server (same process)
  +-- tmux session "grove"
       +-- orchestrator pane (claude --dangerously-skip-permissions)
       +-- worker pane 1 (ephemeral)
       +-- worker pane 2 (ephemeral)
       +-- ...
  +-- cloudflared tunnel (child process, optional)
```

All processes are children of the broker. `grove down` sends SIGTERM to the broker, which cleans up everything.
