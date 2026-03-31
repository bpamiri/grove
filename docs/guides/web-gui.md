# Web GUI

Grove's web interface is a three-panel React application served by the broker at `http://localhost:{port}`. Access it locally or remotely through the Cloudflare tunnel.

---

## Layout

```
┌──────────┬─────────────────────┬──────────────┐
│ Sidebar  │     Task List       │    Chat      │
│          │                     │              │
│ Trees    │  Task cards with    │ Orchestrator │
│ Dashboard│  live status        │ conversation │
│ Status   │                     │              │
└──────────┴─────────────────────┴──────────────┘
```

Panel dividers are draggable. On mobile, the layout switches to a tabbed view (Trees / Tasks / Chat) with navigation at the bottom.

---

## Filtering and Navigation

### Status Filter Tabs

Four filter tabs sit above the task list:

| Tab | Shows |
|-----|-------|
| **All** | All tasks regardless of status |
| **Active** | Tasks with status `queued` or `active` |
| **Failed** | Tasks with status `failed` |
| **Done** | Tasks with status `completed` |

Each tab shows a live count of matching tasks. The selected filter persists across page refreshes via `localStorage`.

### Tree Selection

Click a tree in the sidebar to filter tasks to that tree only. Click **The Grove** (top of sidebar) to show all trees.

### Cross-Filtering

Status and tree filters compose. Selecting tree "api-server" and status "Active" shows only active tasks for api-server. Sidebar tree counts update to reflect the active status filter — so you can see at a glance which trees have failed tasks.

### Filter Persistence

Both the status filter and selected tree persist to `localStorage`:
- `grove-status-filter` — stores the active tab (all/active/failed/done)
- Selected tree is preserved across refreshes

---

## Task Cards

Each task card shows:

- **Title** and tree name
- **Task ID** and path name (e.g., `W-042 · development`)
- **Status badge** — color-coded: gray (draft), blue (queued), amber (active), green (completed), red (failed)
- **Cost** — USD spend and elapsed time (e.g., `$1.23 · 1h 23m`)
- **Seed badge** — indicates if the task has brainstorm results
- **Pipeline progress** — mini step indicator showing how far the task has progressed

### Activity Indicators

Active tasks show a real-time activity ticker:

- **"Working"** spinner with elapsed time
- **Current tool** — shows what the worker is doing right now

The activity stream is powered by the worker's stream-json output, parsed in real-time and broadcast via WebSocket. Activity messages use the format `{tool_name}: {argument}` — for example:

| Activity message | Meaning |
|-----------------|---------|
| `str_replace_based_edit_tool: /src/auth.ts` | Editing a file |
| `Read: /src/config.ts` | Reading a file |
| `Bash: npm test` | Running a shell command |
| `Grep: pattern` | Searching codebase |
| `thinking: considering the auth flow...` | Claude is reasoning |

### Inline Actions

| Button | Appears on | Action |
|--------|-----------|--------|
| **Dispatch** | Draft tasks | Promotes to queued and starts the pipeline |
| **Retry** | Failed/paused tasks | Re-dispatches the task |
| **Cancel** | Active tasks | Kills the worker and marks failed |
| **Plan Batch** | Task list header (when 2+ drafts in selected tree) | Opens the batch planner |

---

## Seeding (Plant a Seed)

Seeding is an interactive brainstorming session with Claude before a task enters the pipeline. It helps refine requirements, explore design options, and generate a specification.

### Starting a Seed

1. Create a draft task
2. Open the task detail
3. Click **Plant a Seed**

This starts a Claude Code session in a tmux window. Claude reads the codebase and begins a design conversation based on the task description.

### The Seed Conversation

The seed panel shows a chat interface:

- Claude's responses appear on the left (with optional HTML fragments for mockups and visual choices)
- Your messages appear on the right
- Claude may present **choice buttons** — clickable options that send your selection as a reply
- **Streaming text** — responses render character-by-character as Claude generates them
- **Stage indicator** — a badge shows the current brainstorm phase: *exploring* → *clarifying* → *proposing* → *designing*
- **Conversation branching** — a fork button on any AI message lets you branch the conversation from that point. A branch selector in the header switches between branches.

The conversation is exploratory. Claude generates design specs, visual mockups, and implementation strategies. There's no code committed during seeding.

### Completing a Seed

When the brainstorm is complete, Claude emits a structured spec. The seed panel collapses to a summary card showing:

- A one-line summary of the design
- The full spec (expandable)
- A **Re-seed** button if you want to start over

The seed spec is passed to the worker when the task is dispatched, giving it design context. Tasks with seeds skip the "plan" step in the pipeline — the seed replaces it.

---

## Dashboard

Access the dashboard from the sidebar. It provides analytics across five tabs:

### Overview Tab

- **KPI cards** — Today's spend, this week's spend, total tasks, gate pass rate
- **Gantt timeline** — Task execution timeline with color-coded status bars. Hover for cost and duration tooltips
- **Time range selector** — 1h, 4h, 24h, 7d. Short ranges (1h, 4h) show a "live" pulsing indicator and auto-refresh via WebSocket

### Activity Timeline Tab

- **Horizontal worker bars** — Each active worker gets a swim lane showing tool use, thinking, and idle periods over time
- **Worker Utilization chart** — Aggregate view of how much time workers spend actively working vs. waiting
- **Task Breakdown view** — Per-task time split across pipeline steps (plan, implement, evaluate, merge)

### Events Tab

- **Filterable event log** — All SAP events (task status changes, gate results, merge outcomes) in a searchable, filterable table
- Filter by event type, task ID, tree, or time range

### Costs Tab

- **Cost by tree** — Horizontal bar chart showing spend per tree
- **Daily spend** — Bar chart of spend by date
- **Top tasks by cost** — Ranked list of most expensive tasks

### Gates Tab

- **Pass rates** — Per-gate percentage with color-split bars (green = passed, red = failed)
- **Retry statistics** — Tasks retried, average retries per task, max retries observed

All analytics data comes from the API:
- `GET /api/analytics/cost?range=24h`
- `GET /api/analytics/gates?range=24h`
- `GET /api/analytics/timeline?range=24h`

---

## Real-Time Updates

The GUI connects to the broker via WebSocket (`ws://localhost:{port}/ws`). All events from the internal event bus are broadcast to connected clients:

- Task status changes
- Worker activity (tool use, thinking)
- Cost updates
- Gate results
- Merge events
- Seed conversation messages

The live activity feed is powered by SAP events (`agent:tool_use`, `agent:thinking`, `agent:text`). The broker maintains a ring buffer of recent events so new connections receive catch-up context immediately. The feed supports a **pause/resume toggle** and automatically truncates long text payloads to keep the UI responsive.

Remote connections (via tunnel) require a Bearer token in the WebSocket handshake. Local connections are auto-authenticated.

---

## DAG Editor

The DAG (Directed Acyclic Graph) editor provides a visual way to manage task dependencies. Access it from the sidebar.

- **ReactFlow visual editor** — tasks appear as draggable nodes, color-coded by status
- **Drag-to-connect edges** — draw an edge from one task to another to create a dependency
- **Cycle prevention** — the editor detects and rejects edges that would create circular dependencies, with visual feedback (the invalid edge flashes red)
- Nodes reflect live task status via WebSocket updates

The DAG editor reads from and writes to the same `task_edges` table used by the dependency system. See [Task Management -- DAG Visualization](task-management.md#dag-visualization) for API details.

---

## Batch Planner UI

When a tree has 2+ draft tasks, a **Plan Batch** button appears. The batch planner has two phases:

**Analyze phase:**
- Click "Analyze Draft Tasks"
- Shows per-task file predictions with confidence indicators (green = high, yellow = medium, gray = low)
- Overlap matrix highlights task pairs sharing predicted files

**Execute phase:**
- Execution waves displayed with task assignments
- "Dispatch" button on each undispatched wave
- Dispatched waves show a green "dispatched" label
- Tasks in later waves automatically get `depends_on` set to previous wave tasks

See [Task Management — Batch Dispatch](task-management.md#batch-dispatch) for details on how wave analysis works.
