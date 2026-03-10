#!/usr/bin/env bash
# lib/commands/tasks.sh — grove tasks
# List tasks with optional filters.

grove_cmd_tasks() {
  grove_require_db

  local show_all=0
  local filter_status=""
  local filter_repo=""

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --all|-a)
        show_all=1
        shift
        ;;
      --status|-s)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove tasks --status STATUS"
        fi
        filter_status="$2"
        shift 2
        ;;
      --status=*)
        filter_status="${1#--status=}"
        shift
        ;;
      --repo|-r)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove tasks --repo REPO"
        fi
        filter_repo="$2"
        shift 2
        ;;
      --repo=*)
        filter_repo="${1#--repo=}"
        shift
        ;;
      -h|--help)
        grove_help_tasks
        return 0
        ;;
      *)
        grove_warn "Unknown option: $1"
        shift
        ;;
    esac
  done

  # Build WHERE clause
  local where_parts=""

  if [ "$show_all" -eq 0 ] && [ -z "$filter_status" ]; then
    where_parts="status != 'completed'"
  fi

  if [ -n "$filter_status" ]; then
    local esc_status
    esc_status=$(grove_db_escape "$filter_status")
    if [ -n "$where_parts" ]; then
      where_parts="$where_parts AND status = '$esc_status'"
    else
      where_parts="status = '$esc_status'"
    fi
  fi

  if [ -n "$filter_repo" ]; then
    local esc_repo
    esc_repo=$(grove_db_escape "$filter_repo")
    if [ -n "$where_parts" ]; then
      where_parts="$where_parts AND repo = '$esc_repo'"
    else
      where_parts="repo = '$esc_repo'"
    fi
  fi

  local sql="SELECT id, repo, title, status, COALESCE(strategy,'-'), COALESCE(estimated_cost,'-'), COALESCE(cost_usd,0) FROM tasks"
  if [ -n "$where_parts" ]; then
    sql="$sql WHERE $where_parts"
  fi
  sql="$sql ORDER BY priority ASC, created_at ASC;"

  local rows
  rows=$(grove_db_query "$sql")

  if [ -z "$rows" ]; then
    if [ -n "$filter_status" ] || [ -n "$filter_repo" ]; then
      grove_info "No tasks match the given filters."
    else
      grove_info "No tasks yet. Run 'grove add' to create one."
    fi
    return 0
  fi

  # Header
  grove_header "Tasks"

  printf '%s%-8s %-12s %-30s %-12s %-10s %-8s%s\n' \
    "$BOLD" "ID" "REPO" "TITLE" "STATUS" "STRATEGY" "COST" "$RESET"
  printf '%-8s %-12s %-30s %-12s %-10s %-8s\n' \
    "────────" "────────────" "──────────────────────────────" "────────────" "──────────" "────────"

  local IFS_SAVE="$IFS"
  while IFS='	' read -r id repo title status strategy est_cost actual_cost; do
    [ -z "$id" ] && continue

    # Truncate title
    local display_title
    display_title=$(grove_truncate "$title" 28)

    # Color badge for status
    local status_display
    case "$status" in
      ingested)   status_display=$(grove_badge "ingested" "blue") ;;
      planned)    status_display=$(grove_badge "planned" "blue") ;;
      ready)      status_display=$(grove_badge "ready" "yellow") ;;
      running)    status_display=$(grove_badge "running" "green") ;;
      paused)     status_display=$(grove_badge "paused" "yellow") ;;
      done)       status_display=$(grove_badge "done" "green") ;;
      review)     status_display=$(grove_badge "review" "yellow") ;;
      completed)  status_display=$(grove_badge "completed" "green") ;;
      failed)     status_display=$(grove_badge "failed" "red") ;;
      *)          status_display=$(grove_badge "$status" "blue") ;;
    esac

    # Strategy display (COALESCE puts '-' for NULL)
    local strat_display="$strategy"

    # Cost display: show actual if > 0, else estimated
    local cost_display="-"
    if [ -n "$actual_cost" ] && [ "$actual_cost" != "0" ] && [ "$actual_cost" != "0.0" ]; then
      cost_display=$(grove_dollars "$actual_cost")
    elif [ -n "$est_cost" ] && [ "$est_cost" != "-" ]; then
      cost_display="~$(grove_dollars "$est_cost")"
    fi

    # Pad after badge manually (ANSI codes break printf width)
    # Badge is [status], visible len = len(status) + 2
    local visible_len=$(( ${#status} + 2 ))
    local pad_needed=$(( 12 - visible_len ))
    if [ "$pad_needed" -lt 1 ]; then pad_needed=1; fi
    local badge_padded="$status_display$(printf '%*s' "$pad_needed" '')"

    printf '%-8s %-12s %-30s %b%-10s %s\n' \
      "$id" "$repo" "$display_title" "$badge_padded" "$strat_display" "$cost_display"
  done << EOF
$rows
EOF
  IFS="$IFS_SAVE"

  # Summary line
  local total
  total=$(grove_db_get "SELECT COUNT(*) FROM tasks;")
  local active=0
  local _line
  while IFS= read -r _line; do
    [ -n "$_line" ] && active=$(( active + 1 ))
  done << EOF
$rows
EOF
  printf '\n%s%s task(s) shown, %s total%s\n' "$DIM" "$active" "$total" "$RESET"
}

grove_help_tasks() {
  printf 'Usage: grove tasks [OPTIONS]\n\n'
  printf 'List tasks with optional filters.\n\n'
  printf 'Options:\n'
  printf '  --all, -a           Include completed tasks\n'
  printf '  --status STATUS     Filter by status\n'
  printf '  --repo REPO         Filter by repo name\n\n'
  printf 'Statuses: ingested, planned, ready, running, paused, done, failed, review, completed\n\n'
  printf 'Examples:\n'
  printf '  grove tasks                  Show all active tasks\n'
  printf '  grove tasks --all            Include completed\n'
  printf '  grove tasks --status ready   Show only ready tasks\n'
  printf '  grove tasks --repo wheels    Show tasks for wheels repo\n'
}
