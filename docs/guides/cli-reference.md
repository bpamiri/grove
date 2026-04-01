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

Starts the Bun HTTP server, initializes the orchestrator, and optionally starts a Cloudflare tunnel. Runs in the foreground. Press Ctrl+C to stop.

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

**Options for `grove tree add`:**

| Flag | Description |
|------|-------------|
| `<path>` | Local filesystem path to the git repo (required, first positional argument) |
| `--github <org/repo>` | GitHub repository slug. Auto-detected from `git remote get-url origin` if omitted. |
| `--name <id>` | Tree ID. Defaults to the directory basename (lowercased, non-alphanumeric chars replaced with `-`). |

Auto-detection parses the GitHub remote URL with the pattern `github.com[:/]org/repo`.

#### grove tree rescan

Re-detect the GitHub remote for a tree.

```bash
grove tree rescan <name>
```

Queries `git remote get-url origin` and updates the tree's `github` field.

#### grove tree remove

Remove a tree from Grove configuration.

```bash
grove tree remove <name>
grove tree remove <name> --force    # Remove even if tree has active tasks
```

| Flag | Description |
|------|-------------|
| `--force` | Remove even if the tree has queued or active tasks |

---

### grove tasks / grove task

List or create tasks.

```bash
grove tasks                          # List all tasks
grove tasks --status active          # Filter by status
grove tasks --tree api-server        # Filter by tree
grove task add "Add auth middleware"  # Create a task
```

**Options for `grove tasks`:**

| Flag | Description |
|------|-------------|
| `--status <status>` | Filter by status: `draft`, `queued`, `active`, `completed`, `failed` |
| `--tree <tree-id>` | Filter by tree ID |

**`grove task add <title>`** creates a draft task with just a title. The title is everything after `add` (leading/trailing quotes are stripped).

> **Note:** `grove task add` only accepts a title. There are no CLI flags for `--tree`, `--description`, `--path`, or `--depends-on`. Use the web GUI or REST API to set those fields. Dependencies are typically set automatically by batch dispatch.

**Filter statuses** (for `--status`): `draft`, `queued`, `active`, `completed`, `failed`

**Display statuses**: The task list may also show internal pipeline states like `running`, `evaluating`, `paused`, or `merged`. These reflect the current step but are not valid `--status` filter values — they map to `active` or `completed` in the filter.

#### Task Actions (via API)

These actions are available through the web GUI and REST API:

| Action | API Endpoint | Description |
|--------|-------------|-------------|
| **Dispatch** | `POST /api/tasks/:id/dispatch` | Promote a draft task to queued and start the pipeline |
| **Resume** | `POST /api/tasks/:id/resume` | Resume a failed/paused task at current or specified step |
| **Retry** | `POST /api/tasks/:id/retry` | Re-dispatch a failed task (increments retry count) |

The resume endpoint accepts an optional `step` field in the request body to resume at a specific pipeline step. See [Task Management](task-management.md) for details.

---

### grove chat

Send a message to the orchestrator.

```bash
grove chat "Implement the login feature"
grove chat "What's the status of the API refactor?"
```

Messages are relayed to the orchestrator subprocess. View the response in the web GUI.

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
| `--agent` | Use AI-assisted analysis for file prediction (~$0.01-0.05 per run) |
| `--hybrid` | Heuristic analysis first, AI fallback for low-confidence tasks |

See [Task Management — Batch Dispatch](task-management.md#batch-dispatch) for details on how wave analysis works.

---

### grove cleanup

Clean up stale worktrees.

```bash
grove cleanup
```

Prunes worktrees for tasks that are completed, failed, or no longer in the database. Requires the broker to be running.

---

### grove config

Manage Grove configuration.

```bash
grove config version              # Show current config version
grove config validate             # Validate grove.yaml against schema
grove config migrate              # Migrate grove.yaml to latest version (backs up first)
```

The `migrate` subcommand creates a backup at `grove.yaml.bak` before applying changes. See [Configuration — Config Versioning](configuration.md#config-versioning) for details.

---

### grove plugins

Manage Grove plugins.

```bash
grove plugins list                # List installed plugins and their status
grove plugins enable <name>       # Enable a plugin
grove plugins disable <name>      # Disable a plugin
```

Plugins are installed to `~/.grove/plugins/<name>/` with a `plugin.json` manifest. See [Configuration — Plugins](configuration.md#plugins) for details.

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
