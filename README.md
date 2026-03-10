# Grove

A unified development command center — coordinating Claude Code sessions across multiple repos, tracking tasks, managing session persistence, and controlling costs.

```
You are the engineering director.
Grove is your engineering manager.
Claude Code sessions are your engineers.
```

You tell Grove what needs to happen. Grove figures out who works on what, in which repo, how many workers. When you sit down Monday morning, Grove tells you exactly where things stand.

## Requirements

- **bash** 3.2+ (macOS default works)
- **python3** (for YAML parsing, date math, JSON processing)
- **sqlite3** (for task/session persistence)
- **gh** CLI (for GitHub sync and PR management) — [install](https://cli.github.com/)
- **claude** CLI (for worker execution) — [install](https://docs.anthropic.com/en/docs/claude-code)

## Installation

```bash
# Clone the repo
git clone https://github.com/bpamiri/grove.git
cd grove

# Add to PATH (add to your ~/.zshrc or ~/.bashrc)
export PATH="$HOME/GitHub/bpamiri/grove/bin:$PATH"

# Initialize
grove init
```

This creates `~/.grove/` with:
- `grove.yaml` — your configuration
- `grove.db` — SQLite database (task/session/event tracking)
- `logs/` — worker output logs

## Configuration

Edit `~/.grove/grove.yaml`:

```yaml
workspace:
  name: "My Workshop"

repos:
  wheels:
    org: cfwheels
    github: cfwheels/wheels
    path: ~/code/wheels
  titan:
    org: paiindustries
    github: paiindustries/titan
    path: ~/code/titan

budgets:
  per_task: 5.00
  per_session: 10.00
  per_day: 25.00
  per_week: 100.00
  auto_approve_under: 2.00

settings:
  max_concurrent: 4
  branch_prefix: "grove/"
  auto_sync: false
```

Or use the CLI:

```bash
grove config                          # View current config
grove config get budgets.per_week     # Get a value
grove config set budgets.per_week 200 # Set a value
grove config edit                     # Open in $EDITOR
grove repos                           # Verify repos
```

## Quick Start

```bash
# 1. Add a task
grove add "Fix route parsing bug" --repo wheels

# 2. Plan it (assigns strategy and cost estimate)
grove plan W-001

# 3. Start working (spawns a Claude Code worker)
grove work W-001

# 4. Monitor progress
grove watch W-001        # Follow worker output
grove dashboard          # See all active workers

# 5. When done, review and close
grove prs                # List open PRs
grove done W-001         # Mark complete after merge
```

## Commands

### The HUD

```bash
grove          # Open the interactive heads-up display
```

The HUD is the "Monday morning" experience. It shows completed tasks, in-progress work, ready tasks, blocked items, and budget status — with numbered choices to resume, start, or review work.

```bash
grove status   # Non-interactive quick summary (pipe-friendly)
```

### Task Management

```bash
grove add                              # Interactive task creation
grove add "description" --repo NAME    # Quick add
grove tasks                            # List all active tasks
grove tasks --status ready             # Filter by status
grove tasks --repo wheels              # Filter by repo
grove tasks --all                      # Include completed
grove plan TASK_ID                     # Assign strategy to a task
grove plan                             # Plan all ingested tasks
grove prioritize                       # Interactive reordering
grove sync                             # Pull issues from GitHub
grove sync --repo wheels               # Sync specific repo
grove sync --dry-run                   # Preview without changes
```

### Task Lifecycle

Every task follows this state machine:

```
ingested → planned → ready → running → done → completed
                                ↓
                             paused → (resume) → running
                                ↓
                             failed
```

- **ingested** — just created (from `add` or `sync`)
- **planned** — strategy assigned (`solo`, `team`, `sweep`)
- **ready** — approved and queued (auto-approved if under `auto_approve_under` budget)
- **running** — a Claude Code worker is active
- **paused** — worker stopped, state saved for resume
- **done** — worker finished, PR may be open
- **completed** — PR merged, task closed
- **failed** — error or cancelled

### Worker Execution

```bash
grove work                  # Grove recommends a batch, you pick
grove work TASK_ID          # Start a specific task
grove work --repo wheels    # Next ready task for a repo
grove run TASK_ID           # Non-interactive (no prompts)
```

Grove creates a git worktree, generates a context-rich prompt (task description, repo CLAUDE.md, session history), and spawns `claude -p` with `--output-format stream-json`.

### Session Persistence

The killer feature. When a worker pauses (you close your laptop, budget limit hit, `grove pause`), Grove saves:
- Session summary (AI-generated handoff notes)
- Modified files and branch state
- Cost/token usage so far
- What the worker was about to do next

When you `grove resume`, all context is injected into the new session. The worker picks up exactly where it left off.

```bash
grove resume TASK_ID    # Resume with full context injection
grove pause TASK_ID     # Save state and stop
grove pause --all       # Pause all running workers
grove cancel TASK_ID    # Stop and clean up (removes worktree)
```

### Live Monitoring

```bash
grove dashboard         # Live-updating display (refreshes every 5s)
grove watch TASK_ID     # Tail a worker's output with formatting
grove detach TASK_ID    # Worker continues in background
grove detach --all      # Detach all workers
grove msg TASK_ID "focus on edge cases"  # Queue message for worker
```

### PR & Review

```bash
grove prs               # List all open Grove PRs across repos
grove prs --repo wheels # Filter to one repo
grove review            # Interactive PR review (open, diff, approve, merge)
grove done TASK_ID      # Mark complete (checks PR is merged)
grove done TASK_ID --force  # Force complete without merge check
grove close TASK_ID     # Abandon a task
```

### Reporting & Costs

```bash
grove cost              # All-time spend breakdown
grove cost --week       # This week (by repo, by strategy)
grove cost --today      # Today's spend
grove report            # Markdown activity summary
grove report --week     # This week's report
grove report --output report.md  # Write to file
grove log               # Last 20 events
grove log TASK_ID       # Events for a specific task
grove log --repo wheels # Events for a repo
grove log --all         # Full event history
```

### Getting Help

```bash
grove help              # Full command listing
grove help COMMAND      # Detailed help for any command
```

## Worker Strategies

When you `grove plan` a task, Grove assigns a strategy based on keyword heuristics:

| Strategy | When | Example |
|----------|------|---------|
| **solo** | Default. Single worker, single repo, focused scope | "Fix route parsing bug" |
| **team** | Keywords: refactor, redesign, overhaul, migration | "Refactor the plugin system" |
| **sweep** | Keywords: audit, scan, validate, review all | "Audit all modules for completeness" |

Strategies affect cost estimates and worker configuration.

## Budget Control

Grove tracks costs at multiple levels:

| Level | Default | Description |
|-------|---------|-------------|
| `per_task` | $5.00 | Max per individual task |
| `per_session` | $10.00 | Max for a single `grove work` session |
| `per_day` | $25.00 | Daily ceiling |
| `per_week` | $100.00 | Weekly ceiling |
| `auto_approve_under` | $2.00 | Tasks below this auto-promote to `ready` |

```bash
grove cost --week    # See current spend
```

Grove checks budgets before dispatching workers and warns/blocks when limits approach.

## Data Storage

All state lives in `~/.grove/`:

```
~/.grove/
  grove.yaml          # Configuration
  grove.db            # SQLite database (WAL mode)
  logs/               # Worker output logs
```

The SQLite database contains 7 tables:

| Table | Purpose |
|-------|---------|
| `repos` | Configured repositories |
| `tasks` | Every task (past and present) |
| `sessions` | Worker session records |
| `events` | Event timeline for logging |
| `audit_results` | Sweep/audit findings |
| `repo_deps` | Cross-repo dependency declarations |
| `config` | Key-value settings store |

You can query the database directly for debugging:

```bash
sqlite3 ~/.grove/grove.db "SELECT id, repo, title, status FROM tasks;"
sqlite3 ~/.grove/grove.db "SELECT * FROM events ORDER BY timestamp DESC LIMIT 10;"
```

## Git Worktrees

Each active task gets an isolated git worktree at `{repo}/.grove/worktrees/{task-id}`. Worktrees:
- Don't pollute your main checkout
- Survive across sessions (that's how resume works)
- Are cheap and native to git
- Get cleaned up when tasks complete or cancel

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROVE_HOME` | `~/.grove` | Override the data directory |
| `GROVE_DEBUG` | `0` | Set to `1` for debug logging |
| `NO_COLOR` | (unset) | Set to disable colored output |
| `EDITOR` | `vi` | Editor for `grove config edit` |

## Project Structure

```
grove/
  bin/grove                  # Entry point — dynamic command router
  lib/
    utils.sh                 # Colors, formatting, logging, prompts
    config.sh                # YAML config loading via python3
    db.sh                    # SQLite helper functions
    prompt.sh                # Worker prompt generation
    worktree.sh              # Git worktree management
    monitor.sh               # Worker output monitoring
    commands/
      init.sh                # grove init
      config-cmd.sh          # grove config
      repos.sh               # grove repos
      help.sh                # grove help
      hud.sh                 # grove (no args)
      status.sh              # grove status
      add.sh                 # grove add
      tasks.sh               # grove tasks
      plan.sh                # grove plan
      prioritize.sh          # grove prioritize
      sync.sh                # grove sync
      work.sh                # grove work / grove run
      resume.sh              # grove resume
      pause.sh               # grove pause
      cancel.sh              # grove cancel
      watch.sh               # grove watch
      detach.sh              # grove detach
      msg.sh                 # grove msg
      dashboard.sh           # grove dashboard
      prs.sh                 # grove prs
      review.sh              # grove review
      done.sh                # grove done
      close.sh               # grove close
      report.sh              # grove report
      cost.sh                # grove cost
      log.sh                 # grove log
  schema.sql                 # Full SQLite schema
  grove.yaml.example         # Example configuration
  docs/
    grove-v2-architecture.md # Architecture document
```

Commands are auto-discovered — drop a new `lib/commands/X.sh` file that exports `grove_cmd_X()` and it's immediately available.

## License

MIT
