#!/usr/bin/env bash
# lib/db.sh — SQLite helper functions
# All database operations go through these wrappers.

# ---------------------------------------------------------------------------
# Core query helpers
# ---------------------------------------------------------------------------

# Execute a SQL statement (no output expected)
grove_db_exec() {
  sqlite3 "$GROVE_DB" "$1"
}

# Return a single scalar value
grove_db_get() {
  sqlite3 "$GROVE_DB" "$1"
}

# Return rows (tab-separated columns)
grove_db_query() {
  sqlite3 -separator '	' "$GROVE_DB" "$1"
}

# Return the count of rows matching a query
grove_db_rows() {
  sqlite3 "$GROVE_DB" "$1"
}

# Formatted table output with headers (column mode)
grove_db_table() {
  sqlite3 -header -column "$GROVE_DB" "$1"
}

# ---------------------------------------------------------------------------
# Database initialization
# ---------------------------------------------------------------------------

# Create all tables from schema.sql and enable WAL mode
grove_db_init() {
  local schema_file="$GROVE_ROOT/schema.sql"
  if [ ! -f "$schema_file" ]; then
    grove_die "Schema file not found: $schema_file"
  fi
  sqlite3 "$GROVE_DB" < "$schema_file" >/dev/null
  grove_debug "Database initialized at $GROVE_DB"
}

# ---------------------------------------------------------------------------
# Existence / convenience checks
# ---------------------------------------------------------------------------

# Check if a row exists. Returns 0 if found, 1 if not.
# Usage: grove_db_exists "tasks" "id = 'W-005'"
grove_db_exists() {
  local table="$1"
  local where_clause="$2"
  local count
  count=$(sqlite3 "$GROVE_DB" "SELECT COUNT(*) FROM $table WHERE $where_clause;")
  if [ "$count" -gt 0 ] 2>/dev/null; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Config table helpers (key-value store)
# ---------------------------------------------------------------------------

# Get a value from the config table
grove_db_config_get() {
  sqlite3 "$GROVE_DB" "SELECT value FROM config WHERE key = '$(grove_db_escape "$1")';"
}

# Upsert a value into the config table
grove_db_config_set() {
  local key
  local val
  key=$(grove_db_escape "$1")
  val=$(grove_db_escape "$2")
  sqlite3 "$GROVE_DB" "INSERT INTO config (key, value) VALUES ('$key', '$val') ON CONFLICT(key) DO UPDATE SET value = '$val';"
}

# ---------------------------------------------------------------------------
# Task helpers
# ---------------------------------------------------------------------------

# Get a single field from a task
grove_db_task_get() {
  local task_id
  local field="$2"
  task_id=$(grove_db_escape "$1")
  sqlite3 "$GROVE_DB" "SELECT $field FROM tasks WHERE id = '$task_id';"
}

# Update a single field on a task
grove_db_task_set() {
  local task_id
  local field="$2"
  local value
  task_id=$(grove_db_escape "$1")
  value=$(grove_db_escape "$3")
  sqlite3 "$GROVE_DB" "UPDATE tasks SET $field = '$value', updated_at = datetime('now') WHERE id = '$task_id';"
}

# Get a task's status
grove_db_task_status() {
  grove_db_task_get "$1" "status"
}

# Update task status, log an event, update timestamps
grove_db_task_set_status() {
  local task_id
  local status
  task_id=$(grove_db_escape "$1")
  status=$(grove_db_escape "$2")
  sqlite3 "$GROVE_DB" "UPDATE tasks SET status = '$status', updated_at = datetime('now') WHERE id = '$task_id';
INSERT INTO events (task_id, event_type, summary) VALUES ('$task_id', 'status_change', 'Status changed to $status');"
}

# Count tasks, optionally filtered by status
grove_db_task_count() {
  local status="${1:-}"
  if [ -n "$status" ]; then
    sqlite3 "$GROVE_DB" "SELECT COUNT(*) FROM tasks WHERE status = '$(grove_db_escape "$status")';"
  else
    sqlite3 "$GROVE_DB" "SELECT COUNT(*) FROM tasks;"
  fi
}

# Return tasks with a given status (tab-separated id, repo, title)
grove_db_tasks_by_status() {
  local status
  status=$(grove_db_escape "$1")
  sqlite3 -separator '	' "$GROVE_DB" "SELECT id, repo, title FROM tasks WHERE status = '$status' ORDER BY priority ASC, created_at ASC;"
}

# Generate the next task ID for a repo prefix.
# E.g., grove_db_next_task_id "W" -> "W-006" (finds max, increments)
grove_db_next_task_id() {
  local prefix="$1"
  local max_num
  max_num=$(sqlite3 "$GROVE_DB" "SELECT COALESCE(MAX(CAST(SUBSTR(id, LENGTH('$prefix') + 2) AS INTEGER)), 0) FROM tasks WHERE id LIKE '$prefix-%' AND id GLOB '$prefix-[0-9]*';")
  local next=$(( max_num + 1 ))
  printf '%s-%03d' "$prefix" "$next"
}

# ---------------------------------------------------------------------------
# Event logging
# ---------------------------------------------------------------------------

# Insert an event record
grove_db_event() {
  local task_id
  local event_type
  local summary
  local detail
  task_id=$(grove_db_escape "${1:-}")
  event_type=$(grove_db_escape "${2:-}")
  summary=$(grove_db_escape "${3:-}")
  detail="${4:-}"
  if [ -n "$detail" ]; then
    detail=$(grove_db_escape "$detail")
    sqlite3 "$GROVE_DB" "INSERT INTO events (task_id, event_type, summary, detail) VALUES ($(grove_db_null "$task_id"), '$event_type', '$summary', '$detail');"
  else
    sqlite3 "$GROVE_DB" "INSERT INTO events (task_id, event_type, summary) VALUES ($(grove_db_null "$task_id"), '$event_type', '$summary');"
  fi
}

# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

# Create a new session record, print its ID
grove_db_session_create() {
  local task_id
  local repo
  task_id=$(grove_db_escape "$1")
  repo=$(grove_db_task_get "$1" "repo")
  sqlite3 "$GROVE_DB" "INSERT INTO sessions (task_id, repo, status) VALUES ('$task_id', '$(grove_db_escape "$repo")', 'running');"
  sqlite3 "$GROVE_DB" "SELECT last_insert_rowid();"
}

# End a session with optional status (default: completed)
grove_db_session_end() {
  local session_id="$1"
  local status="${2:-completed}"
  sqlite3 "$GROVE_DB" "UPDATE sessions SET ended_at = datetime('now'), status = '$(grove_db_escape "$status")' WHERE id = $session_id;"
}

# ---------------------------------------------------------------------------
# SQL escaping helpers
# ---------------------------------------------------------------------------

# Escape single quotes for safe SQL embedding
grove_db_escape() {
  local str="$1"
  printf '%s' "${str//\'/\'\'}"
}

# Return SQL NULL if value is empty, else single-quoted value
grove_db_null() {
  local val="$1"
  if [ -z "$val" ]; then
    printf 'NULL'
  else
    printf "'%s'" "$(grove_db_escape "$val")"
  fi
}

# ---------------------------------------------------------------------------
# Cost / budget helpers
# ---------------------------------------------------------------------------

# Sum of today's costs across all sessions
grove_db_cost_today() {
  local result
  result=$(sqlite3 "$GROVE_DB" "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE date(started_at) = date('now');")
  printf '%s' "$result"
}

# Sum of this week's costs (Monday through Sunday)
grove_db_cost_week() {
  local result
  result=$(sqlite3 "$GROVE_DB" "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE started_at >= date('now', 'weekday 1', '-7 days');")
  printf '%s' "$result"
}

# Check if an additional amount would exceed the weekly budget.
# Returns 0 if within budget, 1 if would exceed.
grove_db_budget_check() {
  local amount="$1"
  local week_cost
  local week_budget
  week_cost=$(grove_db_cost_week)
  week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")
  python3 -c "
import sys
current = float(sys.argv[1])
additional = float(sys.argv[2])
limit = float(sys.argv[3])
sys.exit(0 if current + additional <= limit else 1)
" "$week_cost" "$amount" "$week_budget"
}
