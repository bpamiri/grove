# Architecture

## Overview

Grove separates **infrastructure** from **intelligence**. The broker handles all infrastructure (HTTP, database, tunnels, process management) while Claude Code agents handle all decision-making.

```
You --- Browser (GUI) --- Tunnel ---+
  |                                  |
  +-- grove CLI -------+             |
                        |             |
                        v             v
              +---------------------------+
              |    Broker (Bun process)    |
              |                           |
              |  HTTP+WS . SQLite . SAP   |
              |  Plugins . Adapters       |
              |  Monitor . Step Engine    |
              +----------+----------------+
                         |
          +--------------+--------------+
          v              v              v
    Orchestrator     Worker(s)     Review/Merge
    (Claude Code)  (configurable)  (skill-backed
    persistent     ephemeral         worker steps)
```

## Components

### Broker

The central Bun process. Lightweight, stable, never makes decisions. Manages:

- **HTTP + WebSocket server** — serves the web GUI, REST API (`/api/*`), and real-time updates
- **SQLite database** — task state, tree config, events, messages, seeds (via `bun:sqlite`, WAL journal)
- **SAP event protocol** — typed JSON events for all broker-agent communication
- **Plugin host** — loads and runs `~/.grove/plugins/` lifecycle hooks
- **Adapter registry** — selects the agent backend (Claude Code, Codex, Aider, Gemini) per task
- **Step engine** — drives tasks through configurable pipelines (plan → implement → review → merge), auto-rebasing the worktree before read-only steps
- **Dispatch queue** — manages concurrent worker slots (default: 5)
- **Health monitor** — detects stalled workers via PID liveness checks and stall timeouts
- **Cost monitor** — tracks Claude API spend against per-task, daily, and weekly budgets
- **Event bus** — typed in-process pub/sub that bridges internal events to WebSocket clients
- **GitHub sync** — auto-creates issues on task creation, closes on PR merge
- **Seed sessions** — interactive brainstorming with Claude
- **Tunnel** — optional Cloudflare quick tunnel for remote access

State persisted to `~/.grove/broker.json` (PID, port, URLs) and `~/.grove/grove.db` (tasks, trees, events). Configuration (`grove.yaml`) uses a `version` field with automatic migration support (`grove config migrate`).

### Orchestrator

A persistent Claude Code session. Each user message spawns a short-lived `claude` CLI subprocess that reconnects to a stored session via `--session-id` (first message) or `--resume` (subsequent). You chat with it to:
- Plan and decompose work across repos
- Create and prioritize tasks
- Review worker output and make decisions

The orchestrator has read-only awareness of all configured trees. It communicates with the broker via structured JSONL events on stdout.

### Workers

Ephemeral agent sessions selected via the adapter abstraction (Claude Code by default; Codex, Aider, and Gemini adapters also available). Each worker:
- Gets an isolated git worktree (branch from the tree's default branch)
- Runs in a sandboxed environment with guard hooks
- Executes one pipeline step (plan, implement, etc.)
- Streams SAP events (tool use, thinking, cost data)
- Commits changes and reports back; performs a WIP checkpoint commit on shutdown
- Is killed after completing its step

Each worker step has a `sandbox` mode (`read-write` or `read-only`) and may declare `skills` that are injected into the worker's context. Read-only steps (like review) cannot modify code. Read-write steps (implement, merge) can.

### Review and Merge (skill-backed worker steps)

Earlier versions of Grove had a built-in in-process evaluator and a merge manager. These have been replaced by **worker steps that invoke skills**:

- **Review step** — a read-only worker step with `skills: ["code-review"]`. The worker reads the diff, runs tests, and writes a structured verdict to `.grove/review-result.json`. The step engine reads `result_key: "approved"` to decide pass/fail.
- **Merge step** — a read-write worker step with `skills: ["merge-handler"]`. The worker pushes the branch, opens a PR, watches CI, and merges on green, writing `.grove/merge-result.json` with `result_key: "merged"`.

Before any read-only step, the step engine auto-rebases the worktree onto the base branch (gated by `settings.rebase_before_eval`, default true). On rebase conflict the step fails and the engine loops back to implement with conflict context.

Plugin `step:pre` / `step:post` / `gate:custom` hooks can extend behavior; custom skills can replace the defaults. The `verdict` step type pauses the pipeline for human decision via `/api/tasks/:id/verdict`.

## Data Flow

1. You create a task (via GUI, CLI, or orchestrator)
2. The step engine picks the task's path (e.g., `development`)
3. Dispatch assigns the first step to an available worker slot
4. Implement worker executes in an isolated worktree, commits, reports completion
5. Review worker (read-only) rebases onto base, reads the diff, runs tests, writes verdict
6. If the verdict is `approved`, the engine advances; otherwise loops back to implement with feedback
7. Merge worker pushes the branch, creates a PR, monitors CI, merges on green
8. Post-merge cleanup removes the worktree and branches; linked GitHub issues are closed

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
  +-- orchestrator subprocess (claude --session-id/--resume, on-demand)
  +-- worker subprocess 1 (ephemeral, via adapter)
  +-- worker subprocess 2 (ephemeral, via adapter)
  +-- ...
  +-- cloudflared tunnel (child process, optional)
```

All processes are children of the broker. `grove down` sends SIGTERM to the broker, which cleans up everything.

---

## Plugin System

Plugins live in `~/.grove/plugins/<name>/` with a `plugin.json` manifest. The `PluginHost` loads enabled plugins at broker startup and invokes them at defined hook points:

- **`gate:custom`** — runs after a review step's skill-produced verdict, can add pass/fail results
- **`step:pre`** — runs before a worker step executes (can modify prompt or skip)
- **`step:post`** — runs after a worker step completes (can inspect output)
- **`notify:custom`** — custom notification channel (alongside Slack/webhook/system)

Manage plugins with `grove plugins list`, `grove plugins enable <name>`, `grove plugins disable <name>`.

---

## Agent Adapters

The `AdapterRegistry` abstracts the agent backend so workers are not tied to Claude Code. Available adapters: `claude-code` (default), `codex-cli`, `aider`, `gemini-cli`. Adapter selection priority:

1. **Per-task** — `adapter` field on the task
2. **Per-tree** — `adapter` field on the tree config
3. **Global default** — `settings.default_adapter` in `grove.yaml`

Each adapter implements spawn, stream parsing, and cost extraction for its CLI.

---

## SAP Event Protocol

All broker-agent communication uses typed JSON events (one per line on stdout). This replaces ad-hoc log parsing with a structured contract. Key event types:

- **`agent:spawned`**, **`agent:tool_use`**, **`agent:thinking`**, **`agent:text`**, **`agent:cost`** — worker lifecycle
- **`seed:response`**, **`seed:chunk`** — seed session streaming
- **`orchestrator:event`** — `<grove-event>` tags parsed from orchestrator output

The broker's stream parser validates each event against the SAP schema before dispatching to the event bus.

---

## Task DAG

Tasks can declare directed dependencies via the `task_edges` table, forming a DAG. The system enforces:

- **Cycle detection** — rejects edges that would create cycles
- **Topological dispatch** — blocked tasks auto-unblock when all predecessors complete
- **Visual editor** — the web GUI renders the DAG with ReactFlow, allowing drag-and-drop edge creation

Batch dispatch (`grove batch`) auto-generates DAG edges from wave analysis (wave N depends on wave N-1).

---

## Worker Checkpointing

When a worker is interrupted (shutdown, stall timeout, budget exceeded), it performs a WIP checkpoint:

- Creates a `checkpoint.json` in the worktree with session state and last activity
- Makes a WIP commit with uncommitted changes
- On resume (`--resume` or `grove task resume`), the worker reads `checkpoint.json` and continues with full context

This prevents work loss during graceful shutdowns and enables cross-session continuity.

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

- **worker** → runs `step:pre` plugin hooks; if `sandbox: "read-only"` and `settings.rebase_before_eval` is true, auto-rebases onto the base branch; then spawns an agent session via `spawnWorker()` (adapter-aware); then runs `step:post` hooks. Review and merge are both worker steps — they differ only in sandbox, skills, and result_file.
- **verdict** → pauses the task and waits for human decision via `POST /api/tasks/:id/verdict`. Used for external PR review paths.

(Older `gate`, `merge`, and `review` step types were migrated to `worker` in config schema v3 — see `src/broker/config-migrations.ts`.)

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
| **Orchestrator** | `orchestrator:started`, `orchestrator:rotated` | Orchestrator session started, session rotated |
| **System** | `broker:started`, `broker:stopped`, `message:new` | Broker started, new chat message |

### WebSocket Bridge

The broker's WebSocket handler subscribes to all event types and forwards them to connected clients. This powers the real-time GUI — task status changes, worker activity indicators, cost updates, and seed messages all flow through this bridge. SAP events from agent subprocesses are parsed and re-emitted through the same bus.

A ring buffer retains recent events so that newly connected WebSocket clients can catch up on missed state. Events are batched before broadcast to reduce WebSocket frame overhead.

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

### Crash and Stall Detection

The health monitor runs two distinct checks:

1. **Crash detection** — sends signal 0 to the worker PID. If the process is gone, the worker is flagged as crashed and the task is recovered.
2. **Stall detection** — checks the log file's `mtime`. If no log activity for `stall_timeout_minutes` (default: 5), the worker is flagged as stalled and killed.

### Cleanup

Workers are killed after completing their step. The worktree is preserved across retries — only cleaned up after a successful merge or manual deletion.

---

## Deep Dive: Review Step (code-review skill)

Grove does not have a built-in evaluator. Review is a **read-only worker step** that delegates to the `code-review` skill (bundled at `skills/code-review/`). The step runs the same adapter machinery as implement, but in read-only sandbox mode.

### Pre-Review Rebase

Before the review worker spawns, the step engine (`src/engine/step-engine.ts`) auto-rebases the worktree onto the base branch when `sandbox: "read-only"` and `settings.rebase_before_eval` is true (the default). See `rebaseOnMain()` in `src/shared/worktree.ts`.

- **Clean rebase** — logs `rebase_completed` and proceeds to spawn the review worker.
- **Conflict** — aborts the rebase, logs `rebase_conflict` with the conflicting files, and fails the step. The engine loops back to implement with conflict context.
- **Unexpected error** — logs `rebase_failed` but continues non-fatally.

### What the Skill Does

The `code-review` skill runs inside a worker session. It walks a structured checklist (reading the diff, running the tree's test command, checking for obvious issues) and writes a structured verdict to the step's `result_file` (default `.grove/review-result.json`).

The step's `result_key` (default `approved`) names the boolean the engine reads to decide success vs failure. Plugin `gate:custom` hooks run after the skill's verdict is read and can add additional pass/fail results.

### Retry Feedback

When the review step's verdict is "not approved," the engine loops back to the preceding worker step (typically `implement`). Review feedback is written to `.grove/review-feedback.md` in the worktree so the next implement run has concrete guidance. See `step-engine.ts:onStepComplete` for the feedback-writing logic.

---

## Deep Dive: Merge Step (merge-handler skill)

Grove does not have a built-in merge manager. Merge is a **worker step** that delegates to the `merge-handler` skill (bundled at `skills/merge-handler/`). It runs as a normal adapter-spawned worker with the merge-handler skill injected.

### What the Skill Does

The merge-handler skill guides the worker through:

1. Push the branch to origin.
2. Open a PR via `gh pr create` with a structured body (task description, cost, linked issue).
3. Poll CI status via `gh pr checks` until pass, fail, or timeout.
4. On pass: merge (`gh pr merge --squash --delete-branch` or equivalent per repo policy).
5. Write `.grove/merge-result.json` with `{ merged: bool, pr_number: N, ... }`.

The step's `result_key: "merged"` tells the engine whether to advance to `$done` or fail.

### Engine Guard

`onStepComplete` has a guard: when a merge step reports success (`result_key === "merged"`), the engine re-reads the task to verify `pr_number` was written. If the worker claimed success without producing a PR, the task fails with "Merge step completed but no PR was created."

### Post-Merge Cleanup

Best-effort cleanup happens in `onStepComplete` when transitioning to `$done`:

- Worktree is removed via `cleanupWorktree()` in `src/shared/worktree.ts`.
- Branches are deleted as part of the `gh pr merge --delete-branch` call.
- Linked GitHub issues are closed by the merge-handler skill (`Closes #N` in the PR body + `gh issue close` where needed).
- Failures in cleanup are logged but don't block task completion.

### CI Failure Recovery

If CI fails during the merge step, the skill records the failing check details in `.grove/merge-result.json`. The engine sees `merged: false`, calls `onStepComplete(taskId, "failure")`, and — if retries remain — re-runs the merge step (or loops back to implement, depending on the path's `on_failure` target).

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

---

## Deep Dive: Orchestrator

The orchestrator (`src/agents/orchestrator.ts`) manages a conversational Claude Code session that plans and decomposes work across repositories. Unlike workers (which run once and exit), the orchestrator maintains session continuity across multiple interactions.

### Architecture

The orchestrator is **not** a persistent process. Each user message spawns a short-lived `claude` CLI subprocess that reconnects to a stored session:

```
User message → broker → orchestrator.sendMessage()
                              │
                              ▼
                     First message:
                       Bun.spawn(["claude", "-p", message,
                         "--session-id", uuid, "--system-prompt", prompt,
                         "--add-dir", tree1, "--add-dir", tree2, ...,
                         "--dangerously-skip-permissions",
                         "--output-format", "stream-json", "--verbose"])

                     Subsequent messages:
                       Bun.spawn(["claude", "-p", message,
                         "--resume", uuid,
                         "--output-format", "stream-json", "--verbose"])
                              │
                              ▼
                     Parse stdout → extract events → emit to bus
                              │
                              ▼
                     Process exits → check message queue → repeat if needed
```

The Claude CLI's `--resume` flag reconnects to a conversation stored on disk by the CLI, giving the orchestrator full memory of prior exchanges without keeping a process alive between messages.

### Session State

The broker holds one in-memory session object:

| Field | Purpose |
|-------|---------|
| `sessionId` | UUID passed to `--session-id` (first message) or `--resume` (subsequent) |
| `status` | `"idle"` or `"running"` — guards against concurrent subprocess execution |
| `pid` | PID of the currently running `claude` subprocess (null when idle) |
| `proc` | Bun subprocess handle for the current invocation |
| `messageQueue` | Messages that arrived while `status === "running"`, processed FIFO on completion |
| `isFirstMessage` | Controls whether to pass `--session-id` (creates session) or `--resume` (reconnects) |

The first message includes the full system prompt, `--add-dir` flags for all configured trees, and `--dangerously-skip-permissions`. Subsequent messages only pass `--resume` — the Claude CLI reconstructs context from the persisted session.

### Message Queueing

If a message arrives while the orchestrator is already running, it's pushed to `messageQueue` and returns immediately. When the current subprocess finishes, the orchestrator's `finally` block drains the queue one message at a time. This serializes all orchestrator interactions without blocking the caller.

### System Prompt

The orchestrator's system prompt (injected on first message only) contains:

1. **Role** — "plan and decompose tasks across repos, delegate to workers via events, do NOT write code"
2. **Available trees** — IDs, paths, and GitHub repos from the database
3. **Active tasks** — last 20 non-terminal tasks (provides situational awareness)
4. **Event format** — schema and examples for `spawn_worker` and `task_update` events
5. **Guidelines** — when to use single vs. multiple workers, dependency chains
6. **Recent messages** — last 20 conversation messages (chronological order)

The `--add-dir` flag gives the orchestrator read access to all tree paths for codebase analysis.

### The `<grove-event>` Protocol

The orchestrator communicates with the broker by writing XML tags inline in its response text:

```
<grove-event>{"type":"spawn_worker","tree":"api-server","task":"W-001","prompt":"Add auth middleware"}</grove-event>
```

The broker's stream parser (`src/agents/orchestrator-events.ts`) extracts these tags via regex, parses the JSON, and dispatches the event. Tags are stripped from the text before forwarding to WebSocket clients.

**Event types:**

| Type | Fields | Effect |
|------|--------|--------|
| `spawn_worker` | `tree`, `prompt`, optional `path_name` | Creates a task in the DB (title and description both set from `prompt`), emits `task:created`, enqueues for dispatch |
| `task_update` | `task`, `field`, `value` | Updates a task field (currently only `status`) |

When `spawn_worker` fires, the broker allocates the next task ID (`W-001`, `W-002`, etc.), inserts the task as `queued` with `path_name` defaulting to `"development"`, and pushes it into the dispatch queue — the same queue used by GUI-created tasks.

### Output Parsing

The orchestrator subprocess writes `--output-format stream-json` to stdout. Each line is one JSON object:

| Line type | Content |
|-----------|---------|
| `assistant` | Claude's response — iterated for `text` blocks (chat content) and `tool_use` blocks (activity) |
| `result` | Final cost and token usage — written to the DB session record |

Text blocks are accumulated and scanned for `<grove-event>` tags. Tool use blocks emit `worker:activity` events with `taskId: "orchestrator"`, powering the activity indicator in the GUI.

### Cost Tracking

Each `dispatchMessage` call creates a DB session row (`orch-<timestamp>`) that tracks cost separately from the in-memory UUID session. The Claude CLI session (UUID) persists across many DB sessions, enabling cost-per-interaction granularity while maintaining conversation continuity.

### Lifecycle

| Event | What happens |
|-------|-------------|
| `grove up` | `orchestrator.init(db)` stores the DB ref — no process spawned |
| First chat message | Session object created, first subprocess spawned with full system prompt |
| Subsequent messages | Subprocess spawned with `--resume`, no system prompt repeated |
| `grove down` | `orchestrator.stop()` kills any running subprocess, nulls session |
| "New Session" (GUI) | Session reset — next message starts fresh with a new UUID |

---

## Deep Dive: Batch Analysis

The batch analyzer (`src/batch/analyze.ts`) predicts file conflicts between draft tasks and groups non-conflicting tasks into parallel execution waves.

### Algorithm Overview

```
Draft tasks → Extract file hints → Match against repo → Build overlap matrix → Derive waves
```

### Step 1: Repository File Scan

`listRepoFiles` walks the repository up to 6 directory levels deep, skipping noise directories (`node_modules`, `.git`, `.grove`, `dist`, `build`, `coverage`, `.next`, `.cache`, `__pycache__`, `.venv`, `vendor`). Returns relative paths.

### Step 2: Hint Extraction

`extractFileHints` concatenates the task title and description, then runs four independent regex passes:

| Pattern | Matches | Example |
|---------|---------|---------|
| File extensions | Literal paths with known extensions (`.ts`, `.py`, `.go`, etc.) | `src/auth/login.ts` |
| PascalCase | Two-or-more-word identifiers | `TaskList`, `BatchPlan` |
| camelCase | Multi-word identifiers | `useTasks`, `handleClick` |
| kebab/snake | Hyphenated or underscored identifiers | `step-engine`, `task_list` |

All patterns require multi-word tokens. Single words like "Fix" produce no hints — this is intentional, as vague titles get `confidence: "low"`.

### Step 3: File Matching

For each hint, three strategies are tried in order (short-circuit on first match):

1. **Direct path** — exact match in the file list
2. **Basename match** — case-insensitive comparison of hint against filenames (without extension)
3. **Normalized match** — strips `-` and `_` before comparing (e.g., `task-list` matches `TaskList.tsx`)

### Step 4: Confidence Assignment

| Confidence | Criteria |
|------------|----------|
| `high` | At least one hint was a literal file path found in the repo |
| `medium` | Files predicted via name matching only |
| `low` | No files predicted |

### Step 5: Overlap Matrix

O(n²) comparison of all task pairs. For each pair, computes the intersection of predicted file sets. Only pairs with shared files are recorded.

### Step 6: Wave Derivation (Greedy Graph Coloring)

Tasks are nodes in a conflict graph. Edges connect tasks that share predicted files. The algorithm assigns each task to the earliest wave that has no conflicts:

```
For each task (in priority order):
  wave = 1
  while any task already in this wave conflicts:
    wave++
  assign task to wave
```

This greedy approach doesn't guarantee the minimum number of waves (that's NP-hard), but produces good results for typical task counts.

### Step 7: Dependency Computation

Wave ordering becomes `depends_on` relationships:

- **Wave 1** tasks — no dependencies, dispatched immediately
- **Wave N** tasks — depend on all tasks in wave N-1

Dependencies are written to the DB at dispatch time (not at analysis time), so editing task descriptions between analyze and dispatch causes re-analysis with updated predictions.

### API and Dispatch

| Endpoint | Purpose |
|----------|---------|
| `POST /api/batch/analyze` | Runs the full algorithm, returns the `BatchPlan` |
| `POST /api/batch/dispatch` | Re-analyzes, writes `depends_on` to the DB, dispatches the target wave |

The dispatch endpoint re-analyzes from scratch rather than caching, making it robust to concurrent task edits.

**Wave cascade:** After wave 1 tasks complete, the dependency enforcement in the dispatch queue (`db.isTaskBlocked` / `db.getNewlyUnblocked`) automatically unblocks and dispatches wave 2 tasks — no polling or scheduler needed.

### Web GUI

The "Plan Batch" button appears when 2+ draft tasks exist in the selected tree. The `BatchPlan` component renders file predictions (color-coded by confidence), overlap pairs, and execution waves with sequential dispatch buttons.

---

## API Reference

All endpoints are served by the broker at `http://localhost:{port}`. Remote access (via tunnel) requires a Bearer token in the `Authorization` header.

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Broker health: version, orchestrator state, worker count, queue depth, task counts, daily/weekly cost |
| POST | `/api/restart` | Restart the broker process (spawns `grove down; sleep 2; grove up` in a detached shell) |
| POST | `/api/rotate-credentials` | Regenerate auth token, tunnel subdomain, and shared secret |

### Trees

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trees` | List all registered trees |
| POST | `/api/trees` | Register a tree. Body: `{ path, id?, github?, branch_prefix? }` |
| GET | `/api/trees/:id/issues` | Fetch open GitHub issues for a tree (proxies `gh issue list`) |
| POST | `/api/trees/:id/import-issues` | Create draft tasks from open GitHub issues. Skips already-imported issues. |
| POST | `/api/trees/:id/rescan` | Re-detect GitHub remote for a tree |
| POST | `/api/trees/:id/import-prs` | Import contributed PRs as draft tasks |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List tasks. Query params: `status`, `tree`. Annotated with seed status. |
| GET | `/api/tasks/:id` | Get a single task with its events and subtasks |
| POST | `/api/tasks` | Create a draft task. Body: `{ title, tree_id?, description?, path_name? }` |
| POST | `/api/tasks/:id/dispatch` | Promote draft → queued. Creates a GitHub issue if needed, then enqueues for pipeline. |
| POST | `/api/tasks/:id/retry` | Re-dispatch a failed task (increments retry count, preserves worktree) |
| POST | `/api/tasks/:id/resume` | Resume at current or specific step. Body: `{ step? }`. Resets retry count. |
| GET | `/api/tasks/:id/activity` | Recent tool-use activity parsed from the worker's stream-json log (last 100 entries) |
| POST | `/api/tasks/:id/verdict` | Submit maintainer verdict on an external PR |
| GET | `/api/tasks/:id/activity/live` | Ring buffer catch-up for real-time activity stream |

### Seeds

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks/:id/seed` | Get seed state and conversation for a task |
| POST | `/api/tasks/:id/seed/start` | Start a brainstorming seed session (spawns Claude subprocess) |
| POST | `/api/tasks/:id/seed/stop` | Stop an active seed session |
| DELETE | `/api/tasks/:id/seed` | Discard a seed to allow re-seeding |

### Orchestrator

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a message to the orchestrator. Body: `{ text }` |
| POST | `/api/orchestrator/reset` | Reset the orchestrator session (next message starts fresh) |
| GET | `/api/messages` | Chat history. Query params: `channel` (default: `"main"`), `limit` (default: 50) |

### Pipelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/paths` | Normalized pipeline step definitions (used by the GUI for step indicators) |

### Batch

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/batch/analyze` | Analyze draft tasks for file conflicts. Body: `{ treeId }`. Returns `BatchPlan`. |
| POST | `/api/batch/dispatch` | Re-analyze, write `depends_on`, dispatch a wave. Body: `{ treeId, wave }`. |

### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/cost?range=` | Cost breakdown by tree, daily spend, top tasks. Ranges: `1h`, `4h`, `24h`, `7d`. |
| GET | `/api/analytics/gates?range=` | Gate pass/fail rates and retry statistics |
| GET | `/api/analytics/timeline?range=` | Task execution timeline for Gantt visualization |

### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | Recent event log. Query params: `task` (filter by task ID), `limit` (default: 20) |

### WebSocket

Connect to `ws://localhost:{port}/ws`. Remote connections require a Bearer token in the first `auth` message.

**Client → Server messages:**

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `token` | Authenticate a remote WebSocket connection |
| `chat` | `text` | Send a message to the orchestrator |
| `action` | `action`, `taskId`, `step?` | Task actions: `pause_task`, `cancel_task`, `resume_task`. The `step` field only applies to `resume_task`. |
| `seed` | `taskId`, `text` | Send a message in a seed conversation |
| `seed_start` | `taskId` | Start a seed session (alternative to REST) |
| `seed_stop` | `taskId` | Stop a seed session (alternative to REST) |

**Server → Client events:** All internal event bus events are broadcast to authenticated WebSocket clients. See [Event Bus](#deep-dive-event-bus) for the full event list.
