# Task Edit (`grove edit`) Design

**Goal:** Allow modifying task fields after creation without delete+re-add, with both CLI flags and interactive mode.

**Problem:** No way to fix a typo, change priority, adjust retries, or add dependencies after task creation. Only option is `grove delete` + `grove add`.

## Command Interface

**`grove edit ID [--field value ...]`**

Two modes (matching `grove add` pattern):

- **Flag mode:** `grove edit T-001 --title "New title" --priority 10 --depends T-002`
- **Interactive mode:** `grove edit T-001` — numbered menu of editable fields, loop until done

### Editable Fields (7)

| Field | Flag | Validation |
|-------|------|------------|
| title | `--title TEXT` | Non-empty string |
| description | `--description TEXT` | Any string (empty to clear) |
| repo | `--repo NAME` | Must exist in config |
| priority | `--priority N` | Positive integer |
| depends_on | `--depends IDS` | Comma-separated, all must exist, no circular deps. Empty to clear. |
| max_retries | `--max-retries N` / `--no-retry` | Non-negative integer. `--no-retry` = 0. |
| strategy | `--strategy NAME` | Must be solo/team/sweep/pipeline |

### Status Gate

Edits allowed on: `ingested`, `planned`, `ready`, `running`, `paused`.

Edits blocked on: `done`, `completed`, `failed` (terminal — historical records).

### Event Logging

One `status_change` event per `grove edit` invocation. Summary lists changed fields: `"Edited: title, priority"`.

## Circular Dependency Detection

When editing `depends_on`:

1. Validate all referenced task IDs exist
2. For each new dependency, DFS-walk its `depends_on` chain
3. If the task being edited appears in any chain → reject with cycle error
4. Walk uses `db.taskGet()`, depth bounded by total task count

Example: editing T-003 depends_on to T-002. Walk T-002 → T-001 → (none) → OK. If T-001 depended on T-003 → cycle → reject.

## Interactive Mode

1. Fetch task, check status gate
2. Display current values for all 7 fields
3. Numbered menu: `1) title ... 7) strategy  0) Done`
4. User picks field → prompted with current value as context
5. Validate, update DB immediately, log event
6. Loop until `0) Done`

Special inputs:
- `depends_on` — comma-separated IDs or empty to clear
- `max_retries` — number or "none" to clear (fall back to global default)
- `strategy` — sub-menu of solo/team/sweep/pipeline
- `repo` — sub-menu of configured repos

Each field change applied immediately (not batched). One event per field changed.

## Decisions

- **7 core fields only** — system-managed fields (status, branch, cost, timestamps) not editable. Prevents state corruption.
- **Both CLI + interactive** — matches `grove add` dual-mode pattern. Flags for scripting, interactive for exploration.
- **Non-terminal status only** — done/completed/failed are immutable historical records. Paused tasks editable (common "fix before resume" scenario).
- **Circular dep detection** — simple DFS walk prevents drain deadlocks.
- **Immediate apply in interactive** — no batching. Each field updated as user confirms.

## Unresolved Questions

- Should editing `strategy` re-run cost estimation automatically?
- Should editing `depends_on` on a `ready` task re-check if it becomes blocked?
