# Grove v2: Unified Development Command Center

## Revised Design — March 2026

---

## What Changed From v1

The first design treated multi-repo as the hard problem. That was wrong.
The hard problem is **continuity and coordination** — being the system of
record for all your active work, across all your repos, across sessions
that might be days apart. Multi-repo is just a property of the workspace,
not the core challenge.

**One tool. Not a layer on top of other tools.**

Grove replaces:
- Your 4-5 open Claude Code windows
- Your mental model of "where was I on that Wheels thing?"
- Your manual coordination between repos
- Your context-switching tax when you sit down after a few days away

---

## The Mental Model

```
You are the engineering director.
Grove is your engineering manager.
Claude Code sessions are your engineers.

You tell Grove what needs to happen.
Grove figures out who works on what, in which repo, how many people.
Grove keeps track of everything.
When you sit down Monday morning, Grove tells you exactly where things stand.
```

---

## How It Feels To Use

### Monday morning — you sit down after a weekend

```
$ grove

┌─────────────────────────────────────────────────────────────┐
│  GROVE — Peter's Workshop                    Mon March 9    │
│                                                             │
│  ☀ Good morning. Here's where things stand.                 │
│                                                             │
│  COMPLETED since you last checked (Friday 4:30pm)           │
│  ✓ wheels#142  Route regex migration        PR #156 merged  │
│  ✓ wheels#143  Fix doc generation           PR #157 review  │
│                                                             │
│  IN PROGRESS (paused — waiting for you)                     │
│  ◉ titan#89   Barcode scanner support       75% · 3 files   │
│    Last: Builder finished scanner service, tests pending     │
│    Next: Resume test writing, then PR                        │
│                                                             │
│  ◉ counterpro Feature audit                 3/5 modules     │
│    Last: Inventory (92%), Purchasing (100%), Sales (78%)      │
│    Next: Run reporting + user-mgmt modules                   │
│                                                             │
│  READY TO START                                             │
│  ○ wheels#148  Plugin system refactor       est. team(2)    │
│  ○ titan#92   Batch import for receiving    est. solo        │
│  ○ titan#95   Error handling overhaul       est. team(3)    │
│                                                             │
│  BLOCKED                                                    │
│  ⊘ counterpro#12  POS terminal integration  needs wheels#148│
│                                                             │
│  Budget: $14.20 spent this week / $50.00 weekly limit       │
│                                                             │
│  What would you like to work on?                            │
│  [1] Resume titan#89   [2] Continue audit   [3] Start new  │
│  [4] Review PRs        [5] Show details     [6] Plan week  │
└─────────────────────────────────────────────────────────────┘
```

You pick [1]. Grove resumes the exact session where it left off:

```
$ grove resume titan#89

Resuming: "Barcode scanner support" in paiindustries/titan
  Branch: grove/titan-89-barcode-scanner
  Last session: Friday 3:45pm (worker: builder, 47 min, $2.10)
  State: Scanner service complete, integration tests needed
  
  Spawning worker in ~/code/titan on branch grove/titan-89-barcode-scanner...
  
  Context loaded:
  - Previous session summary (auto-generated)
  - Files modified: src/features/receiving/scanner.ts (new),
    src/bridge/barcode.ts (modified), src/features/receiving/index.ts
  - Scout report from initial exploration phase
  
  Worker is running. You can:
  - Watch:  grove watch titan#89
  - Detach: grove detach (worker continues in background)
  - Talk:   grove msg titan#89 "focus on edge cases for invalid barcodes"
```

### Adding new work — at any time

```
$ grove add

What needs to happen?
> The wheels router needs to support optional path segments like /users/:id?/profile

Grove analyzing...
  Repo: wheels (detected from description)
  Related: wheels#142 (route regex migration — completed)
  Estimated scope: 3-5 files in src/routing/
  Suggested strategy: solo (focused, single-repo, small scope)
  
Created: W-005 "Optional path segment support"
  Source: manual
  Strategy: solo
  Status: ready
  
Start now? [y/N]
```

Or pull from GitHub directly:

```
$ grove sync

Syncing issues from 3 orgs, 5 repos...

  cfwheels/wheels:     2 new, 1 updated
  paiindustries/titan: 1 new
  paiindustries/miranda: 0 changes
  bpamiri/counterpro:  3 new

New tasks added:
  W-006  wheels#152     "Middleware pipeline redesign"    est. team(3)
  W-007  wheels#153     "Add route caching"              est. solo
  T-006  titan#98       "Receiving module dark mode"     est. solo
  C-005  counterpro#15  "Invoice PDF generation"         est. team(2)
  C-006  counterpro#16  "Customer search improvements"   est. solo
  C-007  counterpro#17  "Multi-warehouse support"        est. team(3)

Review and prioritize? [y/N]
```

### Starting a work session

```
$ grove work

You have 8 tasks ready. Based on dependencies and priorities:

Recommended batch (fits within budget + concurrency limits):
  1. W-005  Optional path segments       solo     ~$1.50
  2. T-006  Receiving dark mode          solo     ~$0.80
  3. C-006  Customer search improvements solo     ~$1.20
  
  Total estimated: ~$3.50, 3 parallel workers

These can all run simultaneously — no conflicts, no shared files.

Start this batch? [y/N/edit]
> y

Dispatching 3 workers...
  W-005 → worker in ~/code/wheels (worktree: grove/W-005)       ● running
  T-006 → worker in ~/code/titan (worktree: grove/T-006)        ● running
  C-006 → worker in ~/code/counterpro (worktree: grove/C-006)   ● running

Live status: grove dashboard
Detach all: grove detach --all
```

### The dashboard — your heads-up display

```
$ grove dashboard

┌─ GROVE DASHBOARD ──────────────────────── refreshing 5s ─┐
│                                                           │
│  ACTIVE WORKERS                                           │
│  ┌────────┬──────────┬────────┬───────┬────────────────┐ │
│  │ Task   │ Repo     │ Worker │ Time  │ Activity       │ │
│  ├────────┼──────────┼────────┼───────┼────────────────┤ │
│  │ W-005  │ wheels   │ solo   │ 4m12s │ editing        │ │
│  │        │          │        │       │ route-parser.ts│ │
│  │ T-006  │ titan    │ solo   │ 3m48s │ running tests  │ │
│  │ C-006  │ counter  │ solo   │ 4m02s │ reading code   │ │
│  └────────┴──────────┴────────┴───────┴────────────────┘ │
│                                                           │
│  SESSION SPEND    $1.82 / $10.00 session limit            │
│  ████████░░░░░░░░░░░░░░░░░░░░░  18%                      │
│                                                           │
│  RECENT EVENTS                                            │
│  4:02pm  W-005  Found 4 files to modify                   │
│  4:01pm  T-006  Tests passing, adding dark mode styles    │
│  4:00pm  C-006  Exploring search implementation           │
│  3:58pm  W-005  Created worktree, reading existing routes │
│  3:58pm  T-006  Created worktree, scout phase             │
│  3:57pm  C-006  Created worktree, scout phase             │
│                                                           │
│  QUEUE (5 waiting)                                        │
│  W-006 middleware redesign · W-007 route caching ·        │
│  C-005 invoice PDF · C-007 multi-warehouse · T-004 batch  │
│                                                           │
│  [w]atch task  [m]essage  [p]ause  [d]etach  [q]uit      │
└───────────────────────────────────────────────────────────┘
```

---

## Architecture

### The Hierarchy (borrowing from Overstory's model)

```
┌──────────────────────────────────────────────────┐
│  GROVE COORDINATOR (persistent, always available) │
│  • Owns the task database                         │
│  • Knows every repo, every task, every session    │
│  • Plans work, assigns strategies                 │
│  • Generates the HUD                              │
│  • Survives across your sessions (it IS the state)│
└────────────────────┬─────────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        │            │                │
  ┌─────▼──────┐ ┌──▼───────┐ ┌─────▼──────┐
  │ wheels     │ │ titan    │ │ counterpro │   ← Repo contexts
  │ supervisor │ │ supervisor│ │ supervisor │     (lightweight,
  └─────┬──────┘ └──┬───────┘ └─────┬──────┘      on-demand)
        │            │                │
   ┌────┴───┐   ┌───┴────┐     ┌────┴───┐
   │workers │   │workers │     │workers │   ← Claude Code sessions
   │(solo,  │   │(solo,  │     │(solo,  │     (claude -p or
   │ team,  │   │ team)  │     │ sweep) │      Agent Teams)
   │ scout) │   │        │     │        │
   └────────┘   └────────┘     └────────┘
```

**Key difference from Overstory:** The coordinator is not a running Claude
Code session. It's a **CLI + SQLite database**. The intelligence comes from
Claude Code sessions that the coordinator spawns. The coordinator itself is
just bookkeeping — fast, stateless, always available, no token cost.

The "supervisor" for each repo is also not a running process. It's a
**CLAUDE.md file + task context** that gets injected into every worker
session for that repo. It's the institutional knowledge about how to
work in that codebase.

### The State Machine

Every task follows this lifecycle:

```
                    ┌──────────┐
                    │ ingested │ ← from GitHub sync, manual add, or scan
                    └────┬─────┘
                         │ grove plan (or auto)
                    ┌────▼─────┐
                    │ planned  │ ← strategy assigned, cost estimated
                    └────┬─────┘
                         │ grove approve (or auto if under threshold)
                    ┌────▼─────┐
                    │  ready   │ ← in the queue, waiting for a slot
                    └────┬─────┘
                         │ grove work / grove run
                    ┌────▼─────┐
           ┌────────│ running  │────────┐
           │        └────┬─────┘        │
           │ error       │ done         │ paused (you left,
           │             │              │  session ended, 
      ┌────▼─────┐ ┌────▼─────┐  ┌────▼─────┐  or budget hit)
      │  failed  │ │   done   │  │  paused  │
      └────┬─────┘ └────┬─────┘  └────┬─────┘
           │             │              │
           │ retry       │ pr_created   │ grove resume
           ▼             ▼              ▼
        (→ready)    (→ review)    (→ running)
```

The critical addition: **paused**. When you close your laptop, when a
session hits its budget limit, when you `grove detach` — the task pauses.
Grove saves:
- Which files were modified
- The branch state
- A session summary (auto-generated by the worker before exit)
- Token/cost so far
- What the worker was about to do next

When you `grove resume`, all of this gets injected into the new session
as context. The worker picks up where it left off.

---

## The Database — Your Source of Truth

This is what gives you continuity across days and weeks.

```sql
-- The repos you work with
CREATE TABLE repos (
  name TEXT PRIMARY KEY,        -- 'wheels', 'titan', 'counterpro'
  org TEXT NOT NULL,             -- 'cfwheels', 'paiindustries', 'bpamiri'
  github_full TEXT NOT NULL,     -- 'cfwheels/wheels'
  local_path TEXT NOT NULL,      -- '~/code/wheels'
  branch_prefix TEXT DEFAULT 'grove/',
  claude_md_path TEXT,           -- path to repo-specific CLAUDE.md
  last_synced TEXT
);

-- Every piece of work, past and present
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,           -- 'W-005', 'T-006', 'C-AUDIT-001'
  repo TEXT REFERENCES repos(name),
  source_type TEXT NOT NULL,     -- 'github', 'manual', 'scan'
  source_ref TEXT,               -- 'wheels#152', file path, etc.
  title TEXT NOT NULL,
  description TEXT,              -- full issue body or spec content
  status TEXT DEFAULT 'ingested',
  priority INTEGER DEFAULT 50,   -- 1=urgent, 100=someday
  
  -- Planning
  strategy TEXT,                 -- 'solo', 'team', 'sweep', 'pipeline'
  strategy_config TEXT,          -- JSON: {team_size:3, roles:[...]}
  estimated_cost REAL,
  estimated_files INTEGER,
  depends_on TEXT,               -- JSON array of task IDs
  
  -- Execution
  branch TEXT,                   -- 'grove/W-005'
  worktree_path TEXT,
  session_id TEXT,               -- Claude Code session ID
  pr_url TEXT,
  pr_number INTEGER,
  
  -- Continuity (the critical part)
  session_summary TEXT,          -- AI-generated "where I left off"
  files_modified TEXT,           -- JSON array of file paths
  next_steps TEXT,               -- AI-generated "what to do next"
  
  -- Metrics
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  time_minutes REAL DEFAULT 0,
  
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Every significant event, for the timeline view
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  repo TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,      -- 'created', 'planned', 'started',
                                 -- 'paused', 'resumed', 'worker_spawned',
                                 -- 'file_modified', 'tests_passed',
                                 -- 'pr_created', 'completed', 'failed',
                                 -- 'message_sent', 'message_received'
  summary TEXT,                  -- human-readable one-liner
  detail TEXT                    -- JSON payload for structured data
);

-- Sweep/audit results (for validation tasks)
CREATE TABLE audit_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  module TEXT NOT NULL,
  status TEXT,                   -- 'pass', 'partial', 'fail', 'pending'
  completeness REAL,             -- 0.0 to 1.0
  findings TEXT,                 -- markdown
  checked_at TEXT
);

-- Cross-repo dependency declarations
CREATE TABLE repo_deps (
  upstream TEXT REFERENCES repos(name),
  downstream TEXT REFERENCES repos(name),
  relationship TEXT,             -- 'depends_on', 'shares_schema', etc.
  PRIMARY KEY (upstream, downstream)
);

-- Your preferences and session state
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- e.g. ('weekly_budget', '50.00'), ('max_concurrent', '4'),
--      ('auto_approve_under', '2.00'), ('last_session', '2026-03-09T16:30:00')
```

---

## The Session Summary — How Continuity Works

This is the most important feature. When a worker session ends (whether
the task is done, paused, or failed), Grove asks the worker to generate a
handoff note before exiting:

```
# Appended to every worker's system prompt:

Before you finish or when told to wrap up, write a session summary
to .grove/session-summary.md in this format:

## Session Summary
**Task:** [task ID and title]
**Duration:** [time] | **Cost:** [tokens/cost]
**Status:** [what state is the work in]

### What I Did
- [bullet list of concrete actions taken]

### Current State
- [what files are modified and their state]
- [are tests passing?]
- [any branches or PRs created?]

### What Comes Next
- [ordered list of remaining steps]
- [any decisions that need human input]
- [any blockers or unknowns]

### Context for Next Session
- [anything the next worker needs to know]
- [gotchas discovered, patterns to follow, etc.]
```

Grove reads this file after each session and stores it in the `tasks` table.
When a task is resumed, this summary plus the git diff becomes the briefing
for the new session. The worker starts with full context of what happened
before, even if it's a completely new Claude Code instance.

---

## Worker Strategies

### Solo — One Worker, One Task, One Repo

The common case. Most of your work is this.

```bash
# Grove does this internally:
cd ~/code/wheels
git worktree add .grove/worktrees/W-005 -b grove/W-005 main
cd .grove/worktrees/W-005

claude -p "$(grove worker-prompt W-005)" \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm *),Bash(npx *)" \
  --max-budget-usd "$TASK_BUDGET" \
  --output-format stream-json \
  2>&1 | grove monitor --task W-005
```

The worker prompt includes:
- The task description (from GitHub issue or spec)
- The repo's CLAUDE.md context
- The session summary (if resuming)
- Grove conventions (branch naming, commit message format, where to write
  the session summary)

### Team(N) — Agent Team Within a Repo

For larger tasks. Grove generates a team kickoff prompt with roles.

```bash
# Grove generates a team prompt like:
#
# You are the team lead for task T-006: "Batch import for receiving"
# in paiindustries/titan.
#
# This task requires:
# - Scout: Read the existing import code and document data formats
# - Builder: Implement batch import with progress tracking
# - Test Writer: Write integration tests with sample CSV data
#
# File ownership:
# - Builder owns: src/features/receiving/batch-import/
# - Test Writer owns: tests/features/receiving/batch-import/
# - Scout is read-only
#
# After all teammates complete, create a PR.

claude --agent-teams \
  --prompt "$(grove team-prompt T-006)" \
  --max-budget-usd "$TASK_BUDGET"
```

### Sweep — Parallel Read-Only Validation

For the CounterPro completeness audit. Multiple parallel workers, each
checking one module, all read-only.

```bash
# Grove spawns one claude -p per module, all in parallel:
for module in inventory purchasing sales-counter reporting user-mgmt; do
  (
    cd ~/code/counterpro
    claude -p "$(grove sweep-prompt C-AUDIT-001 $module)" \
      --allowedTools "Read,Glob,Grep" \
      --max-budget-usd 1.00 \
      --output-format json \
      | grove collect-sweep --task C-AUDIT-001 --module "$module"
  ) &
  PIDS+=($!)
done

# Wait and aggregate
for pid in "${PIDS[@]}"; do wait $pid; done
grove sweep-report C-AUDIT-001
```

### Pipeline — Cross-Repo Sequential/Parallel

The rare case. A change that must ripple across repos.

```
Phase 1 (upstream):
  grove run X-001 --phase 1
  → Worker in wheels modifies the ORM schema
  → Creates PR, records the diff

Phase 2 (downstream, parallel):
  grove run X-001 --phase 2
  → Worker in titan gets the wheels diff as context
  → Worker in counterpro gets the wheels diff as context
  → Both run simultaneously, create their own PRs
  → All PRs are linked in descriptions
```

---

## The CLI — One Command For Everything

```
grove                          Open the HUD (default action)
grove status                   Quick text summary (non-interactive)

TASK MANAGEMENT
grove add                      Add a task (interactive)
grove add "description"        Add a task (quick, Grove detects repo)
grove add --repo wheels "..."  Add a task to a specific repo
grove sync                     Pull issues from all GitHub repos
grove scan                     Auto-discover work (new issues, TODOs, etc.)
grove plan [TASK]              Assign strategy to queued tasks
grove prioritize               Interactive priority adjustment

EXECUTION
grove work                     Start working (Grove picks best batch)
grove work TASK                Start a specific task
grove work --repo wheels       Work on the next wheels task
grove resume TASK              Resume a paused task
grove run TASK                 Execute without interactive prompts
grove detach [TASK|--all]      Let workers continue in background
grove pause TASK               Ask a worker to pause and save state
grove cancel TASK              Stop and abandon a task

MONITORING
grove dashboard                Live-updating TUI with all workers
grove watch TASK               Follow a specific worker's output
grove msg TASK "message"       Send a message to a running worker
grove log [TASK]               Event log (all or per-task)

REVIEW
grove prs                      List all open Grove PRs across repos
grove review                   Interactive PR review workflow
grove done TASK                Mark task complete (after PR merge)
grove close TASK               Close without completing

REPORTS
grove report                   Generate markdown summary
grove report --week            This week's activity
grove cost                     Cost breakdown
grove cost --week              This week's spend

CONFIGURATION
grove init                     Set up ~/.grove/ and grove.yaml
grove repos                    List configured repos
grove config                   Edit settings
```

### The Key Interaction: Just `grove`

When you type `grove` with no arguments, you get the HUD. It shows you:

1. What happened since you last looked
2. What's running right now
3. What's paused and can be resumed
4. What's ready to start
5. What's blocked and why

This is the "Monday morning" experience. You never have to remember where
you were. Grove remembers.

---

## Repo-Level Integration

Each repo gets a `.grove/` directory (gitignored) that contains:

```
wheels/
  .grove/
    supervisor.md        ← repo-specific instructions for workers
    worktrees/           ← active worktrees for this repo
    sessions/            ← session summaries for resumability
    scout-reports/       ← research output that persists
```

The `supervisor.md` is a lightweight version of Overstory's agent definitions,
but specific to this repo:

```markdown
# Wheels — Grove Supervisor Context

## About This Repo
Wheels is a CFML MVC framework. See CLAUDE.md for full context.

## Working Conventions
- Tests: `box testbox run`
- Linting: `box cfformat check`
- Branch naming: `grove/{task-id}-{short-description}`
- Commit format: `grove({task-id}): description`
- Always run tests before declaring done

## Architecture Notes
- Route matching lives in wheels/routing/
- ORM lives in wheels/model/
- Plugin system lives in wheels/plugins/
- DO NOT modify wheels/core/ without explicit approval

## Known Gotchas
- The test suite requires Lucee 6+ running
- Route tests use a fixture in tests/fixtures/routes/
- Some legacy tests are flaky — ignore failures in tests/legacy/
```

This gets injected into every worker that operates on this repo. It's
your accumulated knowledge about how to work effectively in each codebase.

---

## Session Persistence — The Killer Feature

### How it saves state

When a worker session ends (for any reason), this happens:

```
1. Worker writes .grove/sessions/{task-id}-{timestamp}.md
   (the session summary described above)

2. Grove CLI reads the summary and updates the DB:
   UPDATE tasks SET
     status = 'paused',
     session_summary = [content of summary],
     files_modified = [git diff --name-only],
     next_steps = [extracted from summary],
     cost_usd = cost_usd + [session cost],
     paused_at = datetime('now')
   WHERE id = [task-id];

3. Grove logs the event:
   INSERT INTO events (task_id, event_type, summary)
   VALUES ([task-id], 'paused', 'Worker completed after 23 min...');

4. The worktree is LEFT IN PLACE with uncommitted changes.
   It's your checkpoint. Git worktrees are cheap.
```

### How it resumes

```
1. grove resume T-006

2. Grove reads from the DB:
   - session_summary: "Finished scanner service, tests pending"
   - files_modified: ["src/features/receiving/scanner.ts", ...]
   - next_steps: ["Write integration tests", "Add error handling"]
   - worktree_path: ".grove/worktrees/T-006"

3. Grove generates a resume prompt:
   
   "You are resuming work on task T-006: Barcode scanner support.
   
   Previous session summary:
   [session_summary content]
   
   Files already modified (in your working tree):
   [list of files with brief descriptions]
   
   What needs to happen next:
   [next_steps content]
   
   The working tree already has your previous changes.
   Continue from where the last session left off."

4. Claude Code starts in the existing worktree with full context.
```

### What makes this different from just reopening Claude Code

When you reopen a raw Claude Code session, you get: nothing. You have to
re-explain what you were doing. With Grove:

- The task description is loaded automatically
- The session summary tells the worker exactly what happened before
- The working tree has all previous changes already in place
- The supervisor.md gives repo-specific conventions
- The event log shows the full history of this task

It's like handing off to a new developer who has read perfect notes from
the previous one.

---

## Cost Control

### Budget Layers

```yaml
# In grove.yaml
budgets:
  per_task: 5.00          # Default max per task
  per_session: 10.00       # Max for a single grove work session
  per_day: 25.00           # Daily ceiling
  per_week: 100.00         # Weekly ceiling
  auto_approve_under: 2.00 # Tasks under this don't need approval
```

Every worker runs with `--max-budget-usd` set from the task budget.
Grove tracks cumulative spend and won't dispatch new work if it would
exceed the session/day/week limits.

### Why this matters

With 4-5 Claude Code windows open, you have no idea what you're spending.
Each session is independent. Grove centralizes cost tracking:

```
$ grove cost --week

This week (March 3-9, 2026)

  By repo:
    wheels      $18.40  (6 tasks)
    titan       $12.20  (3 tasks)
    counterpro   $8.60  (2 tasks + audit)
    ─────────────────────────────
    Total       $39.20  / $100.00 weekly budget

  By strategy:
    solo        $14.80  (8 tasks, avg $1.85)
    team        $18.20  (3 tasks, avg $6.07)
    sweep        $6.20  (1 audit, 5 modules)

  Most expensive: T-006 Barcode scanner ($6.40, team of 3)
  Cheapest:       W-007 Route caching ($0.60, solo)
```

---

## Implementation Plan

### Phase 0: The Skeleton (Day 1)

**Build:** The `grove` bash script, `grove.yaml` for your actual repos,
SQLite schema, `grove status` command.

**Result:** You can type `grove` and see an empty HUD. You can configure
your repos. The database exists.

### Phase 1: Task Tracking (Day 2-3)

**Build:** `grove add`, `grove sync`, `grove tasks`, task lifecycle management.

**Result:** You can add tasks manually, sync from GitHub, see everything in
one list. This is immediately useful even without any automation — it's your
unified task tracker.

### Phase 2: Solo Execution (Day 4-7)

**Build:** `grove work` for solo tasks, worktree management, `grove watch`,
`grove detach`, the session summary system, `grove resume`.

**Result:** You can queue a task, have it run, detach, come back later,
and resume. This replaces one of your Claude Code windows.

### Phase 3: Dashboard + HUD (Week 2)

**Build:** `grove dashboard` TUI, the "Monday morning" greeting,
event logging, `grove report`.

**Result:** The heads-up display that makes you feel in control. You see
everything at a glance. This is when you stop needing multiple windows.

### Phase 4: Parallel Workers (Week 2-3)

**Build:** Concurrent solo workers, the dispatch planner, budget tracking.

**Result:** `grove work` can run 3-4 solo tasks across repos simultaneously.
This replaces ALL of your Claude Code windows with a single `grove dashboard`.

### Phase 5: Team + Sweep Strategies (Week 3-4)

**Build:** Agent Teams integration for team tasks, sweep execution for audits.

**Result:** Complex tasks get appropriate worker configurations. The
CounterPro audit runs as a proper sweep.

### Phase 6: Pipeline + Polish (Week 4+)

**Build:** Cross-repo pipeline execution, PR linking, auto-sync scheduling,
the full `grove` no-args experience.

**Result:** The complete system. One tool for all your development
coordination.

---

## What This IS vs What This ISN'T

### Grove IS:
- Your personal engineering manager
- A task queue with intelligent dispatch
- A session persistence layer (come back in 3 days, know exactly where
  you are)
- A unified view across all your repos and orgs
- A cost control system
- A thin coordination layer over Claude Code's existing primitives

### Grove IS NOT:
- A replacement for Claude Code (it uses Claude Code under the hood)
- An agent framework (no custom messaging, no custom agent types)
- A CI/CD system (it creates PRs, you merge them)
- A team tool (it's for you, the solo developer managing multiple projects)
- Overstory (no persistent coordinator daemon, no SQLite mail system,
  no custom merge queue — just task tracking + dispatch)

---

## Tech Decisions

**CLI in Bash (Phase 0-2), then TypeScript/Bun (Phase 3+)**

Start with bash because it works today with zero dependencies. When the
dashboard needs a proper TUI (ncurses/blessed/ink), graduate to Bun +
TypeScript. This is the same runtime Overstory uses, so if you ever want
to integrate their worktree/merge logic, it's compatible.

**SQLite for everything**

Tasks, events, audit results, config. One file, WAL mode, works everywhere.
The `sqlite3` CLI can query it directly for debugging. No server, no setup.

**Git worktrees for isolation**

Each active task gets a worktree. Cheap, native, doesn't pollute your main
checkout. Worktrees survive across sessions — that's how resume works.

**`claude -p` for execution, not a library**

Grove doesn't import Claude Code as a dependency. It shells out to `claude -p`
(headless mode) with structured prompts. This means Grove works with whatever
version of Claude Code you have installed, including new features like Agent
Teams, without Grove needing updates.

**YAML for config, Markdown for task specs and session summaries**

Human-readable, human-editable, version-controllable. No binary formats,
no proprietary schemas.
