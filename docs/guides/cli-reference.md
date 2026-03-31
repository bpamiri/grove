# CLI Reference

## Global Options

```
grove --version, -v    Print version
grove --help, -h       Show help
grove help             Detailed help with all commands
```

## Commands

### grove init

Initialize Grove data directory.

```bash
grove init
```

Creates `~/.grove/` with configuration, database, and log directory. Safe to run multiple times — exits if already initialized.

---

### grove up

Start the broker, orchestrator, and tunnel.

```bash
grove up
```

Starts the Bun HTTP server, spawns the orchestrator in a tmux session named `grove`, and optionally starts a Cloudflare tunnel. Runs in the foreground. Press Ctrl+C to stop.

Also performs a background update check (see [Upgrading](../getting-started/upgrading.md)).

---

### grove down

Gracefully stop everything.

```bash
grove down
```

Sends SIGTERM to the broker process, which stops workers, orchestrator, tunnel, and cleans up.

---

### grove status

Show system health.

```bash
grove status
```

Displays broker PID, URL, orchestrator state, active worker count, task counts by status, and daily cost.

---

### grove trees / grove tree

List or add repositories.

```bash
grove trees                              # List all trees
grove tree add <path>                    # Add a repo
grove tree add <path> --github org/repo  # Override GitHub remote
grove tree add <path> --name my-tree     # Override tree ID
```

`tree add` auto-detects the GitHub remote from `git remote -v`. The tree ID is derived from the directory name (lowercase, special chars replaced with `-`).

---

### grove tasks / grove task

List or create tasks.

```bash
grove tasks                          # List all tasks
grove tasks --status running         # Filter by status
grove tasks --tree api-server        # Filter by tree
grove task add "Add auth middleware"  # Create a task
```

Task statuses: `draft`, `queued`, `active`, `completed`, `failed`

#### Task Actions (via API)

These actions are available through the web GUI and REST API:

| Action | API Endpoint | Description |
|--------|-------------|-------------|
| **Dispatch** | `POST /api/tasks/:id/dispatch` | Promote a draft task to queued and start the pipeline |
| **Resume** | `POST /api/tasks/:id/resume` | Resume a failed/paused task at current or specified step |
| **Retry** | `POST /api/tasks/:id/retry` | Re-dispatch a failed task (increments retry count) |

The resume endpoint accepts an optional `step_id` in the request body to resume at a specific pipeline step. See [Task Management](task-management.md) for details.

---

### grove chat

Send a message to the orchestrator.

```bash
grove chat "Implement the login feature"
grove chat "What's the status of the API refactor?"
```

Messages are relayed to the orchestrator's tmux session. View the response via `tmux attach -t grove` or the web GUI.

---

### grove batch

Analyze draft tasks for file conflicts and plan parallel execution waves.

```bash
grove batch <tree>                # Analyze and display batch plan
grove batch <tree> --run          # Analyze and auto-dispatch wave 1
grove batch <tree> --json         # Output plan as JSON
```

Requires 2+ draft tasks in the specified tree. The analyzer predicts which files each task will modify, builds an overlap matrix, and groups non-conflicting tasks into execution waves.

**Options:**

| Flag | Description |
|------|-------------|
| `--run` | Skip the confirmation prompt and dispatch wave 1 immediately |
| `--json` | Output the full batch plan as JSON (useful for scripting) |

See [Task Management — Batch Dispatch](task-management.md#batch-dispatch) for details on how wave analysis works.

---

### grove cost

Show spending breakdown.

```bash
grove cost
```

Displays today's spend and this week's spend in USD.

---

### grove upgrade

Update to the latest version.

```bash
grove upgrade
```

Downloads the latest release from GitHub, verifies the SHA256 checksum, and replaces the current binary. See [Upgrading](../getting-started/upgrading.md) for details.
