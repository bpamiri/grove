# Configuration

Grove is configured via `~/.grove/grove.yaml`. The file is created automatically by `grove init` with sensible defaults. Edit it directly to customize behavior.

---

## Version

```yaml
version: 2
```

| Field | Description |
|-------|-------------|
| `version` | Config schema version (integer). If missing, auto-detected as v1. Use `grove config migrate` to upgrade to the latest version. |

---

## Workspace

```yaml
workspace:
  name: "My Project"
```

| Field | Description |
|-------|-------------|
| `name` | Display name for the Grove instance. Shown in the GUI header and system prompts. Required. Defaults to `"Grove"`. |

---

## Trees

Trees are repositories under Grove management. Each tree has its own path, GitHub identity, and quality gate configuration.

```yaml
trees:
  api-server:
    path: ~/code/api-server
    github: myorg/api-server
    default_branch: main
    branch_prefix: grove/
    quality_gates:
      tests: true
      lint: true
      commits: true
      diff_size: true
      max_diff_lines: 5000
      test_command: "npm test"
      lint_command: "npx eslint ."
      test_timeout: 300
      lint_timeout: 60
```

**Fields:**

| Field | Description |
|-------|-------------|
| `path` | Filesystem path to the repo. Supports `~` expansion. |
| `github` | `org/repo` identifier. Auto-detected from git remote by `grove tree add`. |
| `default_branch` | Base branch for worktrees. Defaults to auto-detected value from git. |
| `branch_prefix` | Prefix applied to worker branches. Defaults to the value in `settings.branch_prefix`. |
| `quality_gates` | Per-tree evaluation criteria (see below). |

**Quality gate fields:**

| Field | Type | Description |
|-------|------|-------------|
| `tests` | bool | Run the test suite during gate evaluation. Default: `true`. |
| `lint` | bool | Run the linter during gate evaluation. Default: `false`. |
| `commits` | bool | Check that at least one commit exists on the branch. Default: `true`. |
| `diff_size` | bool | Fail the gate if the diff is outside the min/max range. Default: `true`. |
| `min_diff_lines` | int | Minimum lines changed (catches empty commits). Default: `1`. |
| `max_diff_lines` | int | Maximum lines changed. Default: `5000`. |
| `test_command` | string | Shell command used to run tests. Required if `tests: true`. |
| `lint_command` | string | Shell command used to run the linter. Required if `lint: true`. |
| `test_timeout` | int | Seconds before the test command is killed. Default: `60`. |
| `lint_timeout` | int | Seconds before the lint command is killed. Default: `30`. |
| `base_ref` | string | Git ref for rebase and diff comparison. Auto-detected if omitted (see below). |

**`base_ref` auto-detection:** When `base_ref` is not set in `quality_gates`, the evaluator resolves it with this priority:
1. `origin/{default_branch}` — if `default_branch` is configured on the tree
2. Probes in order: `origin/main`, `main`, `origin/master`, `master`
3. Final fallback: `origin/main`

Override `base_ref` when your tree's target branch differs from the default (e.g., rebasing against a release branch).

**Gate tiers:** Tests and commits are **hard** gates — failure blocks the merge. Lint and diff_size are **soft** gates — failures are logged as warnings but don't block.

---

## Paths (Workflow Templates)

Paths define task pipelines — the sequence of steps a task moves through from intake to completion. Grove ships with built-in paths; you can also define custom ones.

```yaml
paths:
  development:
    description: "Standard dev workflow with QA"
    steps:
      - id: plan
        type: worker
        prompt: "Analyze requirements and outline approach."
      - id: implement
        type: worker
        prompt: "Implement the task. Commit with conventional commits."
      - id: evaluate
        type: gate
        on_failure: implement

  research:
    description: "Research without code changes"
    steps: [plan, research, report]
```

**Step types:**

| Type | Description |
|------|-------------|
| `worker` | Spawns a Claude Code worker session to execute the step. |
| `gate` | Runs quality evaluation (tests, lint, diff size) against the current state. |
| `merge` | Pushes the branch, creates a PR, monitors CI, and auto-merges on green. |
| `review` | Spawns an adversarial reviewer session that critiques a plan and writes a verdict. |
| `verdict` | Waits for a maintainer decision on an external PR (approve/reject/revise). |

**Step fields:**

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the step within the path. |
| `type` | `worker`, `gate`, `merge`, `review`, or `verdict`. Inferred from `id` if omitted. |
| `prompt` | Instructions passed to the worker (worker steps only). |
| `label` | Display name shown in the GUI pipeline indicator. Auto-generated from `id` (capitalized) if omitted. |
| `on_success` | Step ID to transition to on success. Defaults to the next step, or `$done` for the last step. |
| `on_failure` | Step ID to transition to on failure. Gates default to the nearest preceding worker; workers default to `$fail`. |
| `max_retries` | Override the global `settings.max_retries` for this specific step. |

**String shorthand:** The `steps` list accepts bare step IDs as strings (`steps: [plan, implement, evaluate]`). Grove expands these to full `PipelineStep` objects using built-in defaults for each named step.

**Built-in paths:**

| Path | Steps | Description |
|------|-------|-------------|
| `development` | implement -> review -> merge | Standard dev workflow with review |
| `research` | research -> report | Research task, no code changes |
| `adversarial` | plan -> review-plan -> implement -> review-code -> merge | Adversarial planning with review loop |
| `refactoring` | analyze -> plan -> implement -> verify -> review -> merge | Code refactoring with analysis and verification |

See [Custom Paths](custom-paths.md) for the full guide on defining pipelines, step types, transitions, type inference, and retry behavior.

---

## Budgets

Cost controls prevent runaway spending across tasks and sessions. All values are in USD.

```yaml
budgets:
  per_task: 5.00
  per_session: 10.00
  per_day: 25.00
  per_week: 100.00
  auto_approve_under: 2.00
```

| Field | Description |
|-------|-------------|
| `per_task` | Maximum spend for a single task before it is paused for approval. |
| `per_session` | Maximum spend across all tasks in one Grove session. |
| `per_day` | Rolling 24-hour spend ceiling. |
| `per_week` | Rolling 7-day spend ceiling. |
| `auto_approve_under` | Tasks estimated below this cost start without prompting for approval. |

---

## Server

```yaml
server:
  port: auto
```

Set `port` to `auto` to let Grove pick a random available port on startup, or provide a specific port number. The active port is written to `~/.grove/broker.json` at runtime.

---

## Tunnel

Grove can expose its local server over a Cloudflare tunnel for remote access or webhook ingestion.

```yaml
tunnel:
  provider: cloudflare
  auth: token
  domain: grove.cloud
  subdomain: auto
  secret: auto
```

| Field | Description |
|-------|-------------|
| `provider` | Tunnel provider. Currently `cloudflare` only. (`bore` and `ngrok` are defined but not yet implemented.) |
| `auth` | Authentication method. `token` requires a Bearer token for API/WebSocket access. `none` disables authentication (local-only use). |
| `domain` | Optional base domain. Register `grove.cloud` for a stable vanity URL. |
| `subdomain` | Subdomain to use. `auto` generates one on first start and persists it. |
| `secret` | Shared secret for webhook validation. `auto` generates one on first start. |

Requires `cloudflared` to be installed and on `$PATH`. If tunnel setup fails, Grove logs the error and continues with localhost-only access.

---

## Settings

Global defaults that apply across all trees unless overridden at the tree level.

```yaml
settings:
  max_workers: 5
  branch_prefix: grove/
  stall_timeout_minutes: 5
  max_retries: 2
  default_adapter: claude-code
  proactive: true
```

| Field | Description |
|-------|-------------|
| `max_workers` | Maximum number of concurrent worker sessions. |
| `branch_prefix` | Default git branch prefix for worker worktrees. Overridable per tree. |
| `stall_timeout_minutes` | Health monitor flags a worker as stuck after this many minutes without output. |
| `max_retries` | Number of times Grove will automatically retry a failed gate before surfacing the failure. |
| `default_adapter` | Agent backend for workers. Options: `claude-code` (default), `codex-cli`, `aider`, `gemini-cli`. Overridable per tree or per task. |
| `proactive` | When `true` (default), the orchestrator receives automatic event notifications — worker failures, evaluation results, merge outcomes, budget alerts, and health warnings. Set to `false` to suppress automatic event feedback; the orchestrator will still respond to user messages but will not receive pipeline notifications. |

---

## Notifications

Grove can send notifications when async events occur — task completions, failures, budget alerts, etc. Notifications are opt-in: if the `notifications` section is absent, nothing fires.

```yaml
notifications:
  slack:
    webhook_url: "https://hooks.slack.com/services/T00/B00/xxx"
    events: [task_completed, task_failed, ci_failed]
  system:
    enabled: true
    quiet_hours:
      start: "22:00"
      end: "07:00"
    events: [task_completed, task_failed]
  webhook:
    url: "https://example.com/grove-events"
    secret: "hmac-secret-here"
    events: [task_completed, task_failed, pr_merged, budget_exceeded]
```

### Channels

**Slack** — Posts to a Slack incoming webhook with Block Kit formatting and color-coded severity bars (green for success, red for failure, yellow for warnings).

| Field | Description |
|-------|-------------|
| `webhook_url` | Slack incoming webhook URL. Required. |
| `events` | List of event names to receive. Omit to receive all events. |

**System** — Desktop notifications via macOS `osascript` or Linux `notify-send`. Suppressed during quiet hours.

| Field | Description |
|-------|-------------|
| `enabled` | Set to `true` to activate. Required. |
| `quiet_hours` | Optional `start`/`end` times (24-hour `"HH:MM"` format) during which notifications are suppressed. |
| `events` | List of event names to receive. Omit to receive all events. |

**Webhook** — Generic HTTP POST to any URL, with HMAC-SHA256 signature in the `X-Hub-Signature-256` header for payload verification.

| Field | Description |
|-------|-------------|
| `url` | Webhook endpoint URL. Required. |
| `secret` | Shared secret for HMAC-SHA256 signing. Required. |
| `events` | List of event names to receive. Omit to receive all events. |

### Notification Events

| Event | Fires when |
|-------|------------|
| `task_completed` | A task finishes successfully. |
| `task_failed` | A task fails. |
| `gate_failed` | A quality gate (tests, lint, diff size) fails. |
| `pr_merged` | A pull request is merged. |
| `ci_failed` | CI fails on a pull request. |
| `budget_warning` | Spend approaches a budget limit. |
| `budget_exceeded` | Spend exceeds a budget limit. |
| `orchestrator_crashed` | The orchestrator or a worker session crashes. |

### Rate Limiting

Notifications are rate-limited to **1 per event type per task per 60 seconds**. Different tasks completing within the same window each fire independently. Budget events (which have no task affiliation) are rate-limited globally.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROVE_HOME` | `~/.grove` | Override the Grove data directory. |
| `GROVE_NO_UPDATE_CHECK` | unset | Set to `1` to disable automatic version checks. |

---

## File Locations

| File | Purpose |
|------|---------|
| `~/.grove/grove.yaml` | Main configuration file. |
| `~/.grove/grove.db` | SQLite database storing task state and history. |
| `~/.grove/auth.token` | Authentication token for the Grove API. |
| `~/.grove/broker.json` | Runtime broker info: PID, port, tunnel URLs. Recreated on each start. |
| `~/.grove/update-check.json` | Cached result of the last version check. |
| `~/.grove/plugins/` | Plugin directory (each plugin in its own subdirectory). |
| `~/.grove/logs/` | Per-session worker logs. |

---

## Config Versioning

The `version` field at the root of `grove.yaml` tracks the config schema version. If missing, the file is treated as v1.

- **`grove config version`** — prints the current version
- **`grove config validate`** — checks the file against the expected schema
- **`grove config migrate`** — upgrades to the latest version, creating a `grove.yaml.bak` backup first

Migrations are additive — new fields get defaults, existing fields are preserved. Run `grove config migrate` after upgrading Grove to pick up new config options.

---

## Plugins

Plugins extend Grove with custom hooks. Install a plugin by placing it in `~/.grove/plugins/<name>/` with a `plugin.json` manifest:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hooks": ["gate:custom", "step:pre", "step:post", "notify:custom"]
}
```

| Hook | When it runs |
|------|-------------|
| `gate:custom` | After built-in evaluator gates — can add custom pass/fail results |
| `step:pre` | Before a worker step executes — can modify prompt or skip the step |
| `step:post` | After a worker step completes — can inspect output |
| `notify:custom` | Custom notification channel alongside Slack/webhook/system |

Manage plugins with `grove plugins list`, `grove plugins enable <name>`, `grove plugins disable <name>`.
