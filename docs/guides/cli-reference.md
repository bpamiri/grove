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

---

### grove chat

Send a message to the orchestrator.

```bash
grove chat "Implement the login feature"
grove chat "What's the status of the API refactor?"
```

Messages are relayed to the orchestrator's tmux session. View the response via `tmux attach -t grove` or the web GUI.

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
