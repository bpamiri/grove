# Security

## Authentication

Grove generates a random 32-character alphanumeric token on first `grove up`, stored at `~/.grove/auth.token` with permissions `0600` (owner read/write only).

The web GUI requires this token for access. When connecting remotely via tunnel, append it as a query parameter:

```
https://your-tunnel-url?token=YOUR_TOKEN
```

Local connections (localhost) are pre-authenticated.

To rotate the token, delete `~/.grove/auth.token` and restart Grove.

## Worker Sandbox

Workers run in isolated environments with multiple layers of protection.

### Git Worktree Isolation

Each worker gets a dedicated git worktree — a separate working directory on its own branch. Workers cannot access other repos or the main branch.

### Guard Hooks

Grove injects PreToolUse hooks into each worker's Claude Code session. These hooks invoke the `grove _guard` subcommand, which parses `CLAUDE_TOOL_INPUT` as JSON and validates each tool call.

**Bash Guard** (`grove _guard bash-danger`) blocks dangerous shell commands:
- `git push`, `git reset --hard` — no direct remote operations
- `rm -rf /`, `sudo` — no destructive system commands
- Safe operations (git status, file reads, build commands) are allowed

**Edit Boundary** (`grove _guard edit-boundary`) restricts file writes:
- `Write` and `Edit` tools are confined to the worktree directory
- System temp directories are allowed (cross-platform via `os.tmpdir()`)
- All other paths are blocked

**Reviewer Guards** enforce stricter rules for adversarial review sessions:
- `grove _guard review-bash` — blocks all git mutation commands (add, commit, checkout, rebase, etc.)
- `grove _guard review-write` — only allows writing to `.grove/review-result.json`
- `Edit` tool is blocked entirely for reviewers

Guard checks use proper JSON parsing (not regex), making them robust against edge cases and cross-platform compatible (macOS, Linux, Windows).

### CLAUDE.md Overlay

Each worker receives a generated `.claude/CLAUDE.md` containing:
- Task context (ID, title, description)
- Step instructions and quality gate requirements
- The repository's own CLAUDE.md content

### Scoped Remote Push

Only the dedicated merge step (a worker running the `merge-handler` skill) performs `git push`, `gh pr create`, and `gh pr merge`. Implement and review workers have no authorization path for remote-write operations — their sandbox hooks and skill prompts keep them local.

## Network Security

- The broker binds to a random ephemeral port (49152+) on localhost
- Remote access requires the Cloudflare tunnel and auth token
- All API endpoints require token authentication for remote requests
- WebSocket connections require token for remote clients

## File Permissions

| File | Permissions | Contents |
|------|-------------|----------|
| `~/.grove/auth.token` | `0600` | Authentication token |
| `~/.grove/grove.yaml` | User default | Configuration |
| `~/.grove/grove.db` | User default | Task state |

## Cost Controls

Budgets prevent runaway spending:

```yaml
budgets:
  per_task: 5.00      # Max per individual task
  per_session: 10.00  # Max for one worker session
  per_day: 25.00      # Daily ceiling
  per_week: 100.00    # Weekly ceiling
```

The cost monitor enforces these limits and pauses work when thresholds are reached.
