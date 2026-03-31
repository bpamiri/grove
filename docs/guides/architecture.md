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
- **SQLite database** — task state, tree config, events, messages, seeds (via `bun:sqlite`, WAL journal)
- **tmux sessions** — orchestrator and worker panes
- **Step engine** — drives tasks through configurable pipelines (plan → implement → evaluate → merge)
- **Dispatch queue** — manages concurrent worker slots (default: 5)
- **Health monitor** — detects stalled workers via PID liveness checks and stall timeouts
- **Cost monitor** — tracks Claude API spend against per-task, daily, and weekly budgets
- **Merge manager** — pushes branches, creates PRs, watches CI, merges on green (sequential per-repo)
- **Event bus** — typed in-process pub/sub that bridges internal events to WebSocket clients
- **GitHub sync** — auto-creates issues on task creation, closes on PR merge
- **Seed sessions** — interactive tmux-based brainstorming with Claude
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
- Streams structured JSON output (tool use, thinking, cost data)
- Commits changes and reports back
- Is killed after completing its step

Workers cannot push to remote. The merge manager handles that.

### Evaluator

Spawned after a worker completes. Runs quality gates:
- **Commits** — checks for conventional commit format (hard gate)
- **Tests** — runs the tree's test command (hard gate)
- **Lint** — runs the tree's lint command (soft gate — warnings only)
- **Diff size** — rejects changes outside the min/max range (soft gate)

Before running gates, the evaluator **rebases onto the base branch** to catch conflicts early. After 3 consecutive rebase failures, the evaluator marks the failure as fatal.

Separate from the worker because models are poor critics of their own output.

Gate results: pass (advance to next step), fail with retry prompt (retry worker up to `max_retries`), or soft warning (pass through).

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

- **Left sidebar** — tree list, dashboard link, system status, navigation
- **Center** — task cards with live status, activity stream, pipeline progress; or analytics dashboard (Overview, Costs, Gates tabs)
- **Right** — orchestrator chat

The **Dashboard** view provides analytics: Gantt-style task timeline, cost breakdown by tree, gate pass/fail rates, and KPI summary cards. Time range selector (1h/4h/24h/7d) with live WebSocket refresh for short ranges.

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

---

## Deep Dive: Step Engine

The step engine (`src/engine/step-engine.ts`) replaces hardcoded pipeline wiring with a configurable state machine. It drives tasks through their assigned path by dispatching steps and handling transitions.

### Key Functions

| Function | Purpose |
|----------|---------|
| `startPipeline(task, tree, db)` | Resolves the task's path, sets the first step, begins execution |
| `resumePipeline(task, tree, db, stepId?)` | Resumes a paused/failed task at current or specified step |
| `onStepComplete(taskId, outcome, context?)` | Called when a step finishes — resolves the next transition |
| `wireStepEngine(db)` | Connects to the event bus to handle dependency unblocking |

### Step Dispatch

When a step executes, the engine looks at its type:

- **worker** → spawns a Claude Code session via `spawnWorker()`
- **gate** → runs `evaluate()` against the worktree
- **merge** → queues the task in the merge manager

Dynamic imports are used to avoid circular dependencies between modules.

### Transitions

Each step outcome maps to a transition target:

- **success** → `on_success` (default: next step, or `$done` if last)
- **failure** → `on_failure` (default: `$fail` for workers, loop to nearest preceding worker for gates)
- **fatal** → always `$fail` (skips retries — used for unrecoverable errors like rebase loops)

### Seed-Aware Initialization

When a task has a seed spec, `startPipeline` skips the "plan" step — the seed replaces planning. The worker receives the spec as context in its prompt.

### Dependency Enforcement

`wireStepEngine` listens for `merge:completed` events. When a task completes, it queries for all tasks with `depends_on` containing the completed task's ID and re-checks their dependency lists. Newly unblocked tasks are dispatched automatically.

---

## Deep Dive: Event Bus

The event bus (`src/broker/event-bus.ts`) is a typed in-process pub/sub system. All communication between broker subsystems flows through it.

### Event Categories

| Category | Events | Examples |
|----------|--------|---------|
| **Task lifecycle** | `task:created`, `task:updated`, `task:status` | Task created, status changed to active |
| **Worker** | `worker:spawned`, `worker:ended`, `worker:activity` | Worker started, editing a file, completed |
| **Evaluation** | `eval:started`, `eval:passed`, `eval:failed` | Gate check started, tests passed |
| **Gates** | `gate:result` | Individual gate pass/fail with message |
| **Merge** | `merge:pr_created`, `merge:ci_passed`, `merge:ci_failed`, `merge:completed` | PR created, CI green, merged |
| **Cost** | `cost:updated`, `cost:budget_warning`, `cost:budget_exceeded` | Spend updated, budget warning |
| **Monitor** | `monitor:stall`, `monitor:crash` | Worker stalled, process crashed |
| **System** | `broker:started`, `broker:stopped`, `message:new` | Broker started, new chat message |

### WebSocket Bridge

The broker's WebSocket handler subscribes to all event types and forwards them to connected clients. This powers the real-time GUI — task status changes, worker activity indicators, cost updates, and seed messages all flow through this bridge.

Events are typed via the `EventBusMap` type in `src/shared/types.ts`. Handler errors are caught silently to prevent one bad subscriber from breaking the event loop.

---

## Deep Dive: Worker Lifecycle

Workers are the primary execution agents. Each worker is an ephemeral Claude Code session running in an isolated git worktree.

### Spawn Sequence

```
1. Create git worktree at {tree}/.grove/worktrees/{taskId}
2. Branch from default branch: {prefix}{taskId}-{slug}
3. Deploy sandbox (CLAUDE.md with task prompt, guard hooks)
4. Spawn: claude -p {prompt} --verbose --output-format stream-json --dangerously-skip-permissions
5. Begin monitoring stdout for stream-json events
```

### Stream Parsing

Worker output is structured JSON (one event per line). The monitor parses:

- **tool_use events** → extracted as activity (editing, reading, testing, etc.)
- **thinking blocks** → displayed as "thinking" in the GUI
- **result events** → final cost and token usage
- **text blocks** → plain output

Activity events are emitted to the event bus and forwarded to WebSocket clients for real-time display.

### Cost Tracking

Costs are extracted from stream-json result events:
- `cost_usd` — total API spend for the session
- `usage.input_tokens` / `usage.output_tokens` — token counts

The broker accumulates session costs onto the task and checks against budget limits (per-task, per-day, per-week).

### Stall Detection

The health monitor checks worker liveness by sending signal 0 to the worker PID. If a worker produces no output for `stall_timeout_minutes` (default: 5), it's flagged as stalled and killed.

### Cleanup

Workers are killed after completing their step. The worktree is preserved across retries — only cleaned up after a successful merge or manual deletion.

---

## Deep Dive: Evaluator

The evaluator (`src/agents/evaluator.ts`) runs quality gates on worker output in a separate process. The separation ensures objectivity — models are poor critics of their own work.

### Pre-Gate Rebase

Before running any gates, the evaluator rebases the task branch onto the base ref:

1. Fetch latest from origin (non-fatal if offline)
2. Compare merge-base against remote HEAD
3. Rebase onto base ref (auto-detected or configured via `base_ref`)
4. On conflict: abort rebase, count consecutive failures

After `MAX_REBASE_FAILURES` (3) consecutive rebase conflicts, the failure escalates to **fatal** — the task stops retrying.

### Gate Checks

| Gate | Tier | Check |
|------|------|-------|
| `commits` | hard | `git log base..HEAD` — at least one commit exists |
| `tests` | hard | Runs `test_command` in the worktree with timeout |
| `lint` | soft | Runs `lint_command` in the worktree with timeout |
| `diff_size` | soft | `git diff --stat` — line count within min/max range |

**Hard gates** block the merge on failure. **Soft gates** log warnings but allow the task to proceed.

### Retry Prompt

When gates fail, the evaluator builds a structured retry prompt listing each failure with its output. This prompt is passed to the worker on retry, giving it specific guidance on what to fix. If the task has a seed spec, it's included for design alignment.

---

## Deep Dive: Merge Manager

The merge manager (`src/merge/manager.ts`) handles the full lifecycle of getting code from a worktree branch into the main branch.

### Sequential Per-Tree Queue

Merges are queued per tree to prevent race conditions:

```
Tree: api-server → [Task A (merging)] → [Task B (waiting)] → [Task C (waiting)]
Tree: frontend   → [Task D (merging)]
```

Different trees merge independently in parallel. Within a tree, merges are strictly sequential.

### Merge Workflow

```
Push branch ──▶ Create PR ──▶ Poll CI (15s intervals, 10m timeout)
                                  │
                      ┌───────────┼───────────┐
                      ▼           ▼           ▼
                  CI passes    CI fails    Timeout
                      │           │           │
                  Auto-merge  Feed failure  Treat as
                  + cleanup   back to       failure
                              worker
```

### PR Body

PRs include structured metadata:
- Task description
- Task ID, path, cost, file count
- Per-gate results with pass/fail status
- `Closes #N` if the task has a linked GitHub issue
- Grove attribution footer

### CI Failure Recovery

On CI failure, the merge manager:
1. Fetches failing check details (name, conclusion, URL)
2. Appends failure context to the task's session summary
3. Calls `onStepComplete(taskId, "failure")` to trigger a retry
4. The worker gets re-spawned with the CI failure context

### Post-Merge Cleanup

After a successful merge:
- Worktree is removed (`git worktree remove --force`)
- Local and remote branches are deleted
- Linked GitHub issue is closed
- All cleanup is best-effort — failures are logged but don't block

---

## Deep Dive: Worktree Management

Each task gets an isolated git worktree, providing full filesystem separation between concurrent workers.

### Directory Structure

```
~/code/api-server/                  # Main tree (your working copy)
  └── .grove/
      └── worktrees/
          ├── W-041/                # Task W-041's isolated copy
          │   ├── .grove/           # Grove metadata
          │   ├── .claude/          # Claude Code config (CLAUDE.md, hooks)
          │   └── src/...           # Full repo checkout
          └── W-042/                # Task W-042's isolated copy
```

### Branch Naming

Format: `{branch_prefix}{taskId}-{slugified-title}`

Example: `grove/W-042-add-auth-middleware`

The slug is lowercase, non-alphanumeric characters replaced with hyphens, max 40 characters.

### Lifecycle

| Phase | What happens |
|-------|-------------|
| **Create** | `git worktree add` with a new branch from the default branch |
| **Reuse** | If the worktree already exists (retry), it's reused as-is |
| **Rebase** | The evaluator rebases onto the latest base ref before gates |
| **Cleanup** | After merge, worktree + branches are removed |

Worktrees are idempotent — calling create on an existing worktree returns the existing path. This means retries and resume operations don't create duplicate worktrees.

### Default Branch Resolution

When creating a worktree, Grove resolves the start point (base branch) with this priority:

1. Configured `default_branch` on the tree
2. `origin/HEAD` (GitHub's default)
3. `origin/develop`, `origin/main`, `origin/master` (in order)
4. Fallback: `origin/main`
