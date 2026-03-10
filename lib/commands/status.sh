#!/usr/bin/env bash
# lib/commands/status.sh — grove status
# Non-interactive quick text summary. Designed for piping/scripting.

grove_cmd_status() {
  # Require init
  if [ ! -f "$GROVE_DB" ]; then
    grove_info "Grove not initialized. Run 'grove init' first."
    return 1
  fi

  grove_require_config

  local ws_name
  ws_name=$(grove_workspace_name 2>/dev/null || echo "Grove")

  printf '%s%s%s  %sstatus%s\n' "$BOLD" "$ws_name" "$RESET" "$DIM" "$RESET"
  printf '\n'

  # --- Counts ---
  local total
  total=$(grove_db_task_count "")
  local running
  running=$(grove_db_task_count "running")
  local paused
  paused=$(grove_db_task_count "paused")
  local ready
  ready=$(grove_db_task_count "ready")
  local review
  review=$(grove_db_task_count "review")
  local done_count
  done_count=$(grove_db_get "SELECT COUNT(*) FROM tasks WHERE status IN ('completed', 'done');")
  local ingested
  ingested=$(grove_db_task_count "ingested")
  local planned
  planned=$(grove_db_task_count "planned")
  local failed
  failed=$(grove_db_task_count "failed")

  if [ "$total" = "0" ]; then
    printf 'No tasks. Run "grove add" or "grove sync" to get started.\n'
    return 0
  fi

  printf 'Tasks: %s total' "$total"
  if [ "$running" -gt 0 ] 2>/dev/null; then
    printf ', %s%s running%s' "$GREEN" "$running" "$RESET"
  fi
  if [ "$paused" -gt 0 ] 2>/dev/null; then
    printf ', %s%s paused%s' "$YELLOW" "$paused" "$RESET"
  fi
  if [ "$ready" -gt 0 ] 2>/dev/null; then
    printf ', %s ready' "$ready"
  fi
  if [ "$review" -gt 0 ] 2>/dev/null; then
    printf ', %s in review' "$review"
  fi
  if [ "$ingested" -gt 0 ] 2>/dev/null; then
    printf ', %s ingested' "$ingested"
  fi
  if [ "$planned" -gt 0 ] 2>/dev/null; then
    printf ', %s planned' "$planned"
  fi
  if [ "$failed" -gt 0 ] 2>/dev/null; then
    printf ', %s%s failed%s' "$RED" "$failed" "$RESET"
  fi
  if [ "$done_count" -gt 0 ] 2>/dev/null; then
    printf ', %s done' "$done_count"
  fi
  printf '\n\n'

  # --- Running tasks ---
  if [ "$running" -gt 0 ] 2>/dev/null; then
    printf 'Running:\n'
    local rows
    rows=$(grove_db_query "SELECT id, repo, title FROM tasks WHERE status = 'running' ORDER BY priority ASC;")
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      printf '  %s  %-8s  %s\n' "$tid" "$trepo" "$(grove_truncate "$ttitle" 50)"
    done <<EOF
$rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- Paused tasks ---
  if [ "$paused" -gt 0 ] 2>/dev/null; then
    printf 'Paused:\n'
    local rows
    rows=$(grove_db_query "SELECT id, repo, title FROM tasks WHERE status = 'paused' ORDER BY priority ASC;")
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      printf '  %s  %-8s  %s\n' "$tid" "$trepo" "$(grove_truncate "$ttitle" 50)"
    done <<EOF
$rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- Ready tasks ---
  if [ "$ready" -gt 0 ] 2>/dev/null; then
    printf 'Ready:\n'
    local rows
    rows=$(grove_db_query "SELECT id, repo, title FROM tasks WHERE status = 'ready' ORDER BY priority ASC, created_at ASC;")
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      printf '  %s  %-8s  %s\n' "$tid" "$trepo" "$(grove_truncate "$ttitle" 50)"
    done <<EOF
$rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- Recent events ---
  local recent_events
  recent_events=$(grove_db_query "SELECT timestamp, event_type, task_id, summary FROM events ORDER BY timestamp DESC LIMIT 5;")

  if [ -n "$recent_events" ]; then
    printf 'Recent activity:\n'
    local old_ifs="$IFS"
    while IFS='	' read -r ets etype etask esummary; do
      [ -z "$ets" ] && continue
      local rel_time
      rel_time=$(grove_relative_time "$ets" 2>/dev/null || echo "$ets")
      local task_str=""
      if [ -n "$etask" ]; then
        task_str="$etask "
      fi
      printf '  %s%-16s%s %s%s\n' "$DIM" "$rel_time" "$RESET" "$task_str" "$(grove_truncate "$esummary" 50)"
    done <<EOF
$recent_events
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- Budget ---
  local week_cost
  week_cost=$(grove_db_cost_week)
  local today_cost
  today_cost=$(grove_db_cost_today)
  local week_budget
  week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")

  printf 'Budget: %s today, %s / %s this week\n' \
    "$(grove_dollars "$today_cost")" \
    "$(grove_dollars "$week_cost")" \
    "$(grove_dollars "$week_budget")"
}

grove_help_status() {
  printf 'Usage: grove status\n\n'
  printf 'Show a quick non-interactive text summary of all tasks.\n\n'
  printf 'Displays:\n'
  printf '  - Task counts by status\n'
  printf '  - Running and paused task details\n'
  printf '  - Ready tasks\n'
  printf '  - Last 5 events\n'
  printf '  - Budget summary\n\n'
  printf 'Suitable for piping or scripting. For the interactive\n'
  printf 'dashboard, run: grove\n'
}
