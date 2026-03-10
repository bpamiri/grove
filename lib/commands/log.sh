#!/usr/bin/env bash
# lib/commands/log.sh — grove log
# Event timeline display.

grove_cmd_log() {
  grove_require_db

  # Parse arguments
  local task_id=""
  local repo_filter=""
  local type_filter=""
  local limit=20
  local show_all=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)   repo_filter="$2"; shift 2 ;;
      --repo=*) repo_filter="${1#--repo=}"; shift ;;
      --type)   type_filter="$2"; shift 2 ;;
      --type=*) type_filter="${1#--type=}"; shift ;;
      --limit)  limit="$2"; shift 2 ;;
      --limit=*) limit="${1#--limit=}"; shift ;;
      --all)    show_all=1; shift ;;
      -*)
        grove_error "Unknown option: $1"
        return 1
        ;;
      *)
        # Positional arg is a task ID
        if [ -z "$task_id" ]; then
          task_id="$1"
        else
          grove_error "Unexpected argument: $1"
          return 1
        fi
        shift
        ;;
    esac
  done

  # Build WHERE clause
  local where_parts=""
  if [ -n "$task_id" ]; then
    local escaped_id
    escaped_id=$(grove_db_escape "$task_id")
    where_parts="task_id = '${escaped_id}'"
  fi
  if [ -n "$repo_filter" ]; then
    local escaped_repo
    escaped_repo=$(grove_db_escape "$repo_filter")
    if [ -n "$where_parts" ]; then
      where_parts="${where_parts} AND repo = '${escaped_repo}'"
    else
      where_parts="repo = '${escaped_repo}'"
    fi
  fi
  if [ -n "$type_filter" ]; then
    local escaped_type
    escaped_type=$(grove_db_escape "$type_filter")
    if [ -n "$where_parts" ]; then
      where_parts="${where_parts} AND event_type = '${escaped_type}'"
    else
      where_parts="event_type = '${escaped_type}'"
    fi
  fi

  local where_clause=""
  if [ -n "$where_parts" ]; then
    where_clause="WHERE ${where_parts}"
  fi

  local limit_clause=""
  if [ "$show_all" = "0" ]; then
    limit_clause="LIMIT ${limit}"
  fi

  # Query events
  local sql="SELECT timestamp, task_id, event_type, summary FROM events ${where_clause} ORDER BY timestamp DESC ${limit_clause};"
  local rows
  rows=$(grove_db_query "$sql")

  if [ -z "$rows" ]; then
    if [ -n "$task_id" ]; then
      grove_info "No events for task $task_id"
    elif [ -n "$repo_filter" ]; then
      grove_info "No events for repo $repo_filter"
    elif [ -n "$type_filter" ]; then
      grove_info "No events of type $type_filter"
    else
      grove_info "No events recorded yet."
    fi
    return 0
  fi

  # Header
  if [ -n "$task_id" ]; then
    printf '\n%sEvents for %s%s\n\n' "$BOLD" "$task_id" "$RESET"
  elif [ -n "$repo_filter" ]; then
    printf '\n%sEvents for %s%s\n\n' "$BOLD" "$repo_filter" "$RESET"
  else
    printf '\n%sEvent Log%s\n\n' "$BOLD" "$RESET"
  fi

  # Display each event
  local old_ifs="$IFS"
  while IFS='	' read -r ets etask etype esummary; do
    [ -z "$ets" ] && continue

    # Determine timestamp display: relative if within last day, otherwise date
    local ts_display
    ts_display=$(python3 -c "
from datetime import datetime, timezone
import sys

ts = sys.argv[1].replace('Z', '+00:00')
try:
    dt = datetime.fromisoformat(ts)
except ValueError:
    try:
        dt = datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    except ValueError:
        print(ts)
        sys.exit(0)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
diff = now - dt
if diff.total_seconds() < 86400:
    seconds = int(diff.total_seconds())
    if seconds < 0:
        print('just now')
    elif seconds < 60:
        print(f'{seconds}s ago')
    elif seconds < 3600:
        m = seconds // 60
        print(f'{m}m ago')
    else:
        h = seconds // 3600
        print(f'{h}h ago')
else:
    print(dt.strftime('%Y-%m-%d %H:%M'))
" "$ets")

    # Color-code event type
    local type_color=""
    case "$etype" in
      created)
        type_color="$BLUE" ;;
      started|resumed)
        type_color="$GREEN" ;;
      paused)
        type_color="$YELLOW" ;;
      failed|cancelled)
        type_color="$RED" ;;
      completed)
        type_color="${GREEN}${BOLD}" ;;
      pr_created|pr_merged)
        type_color="$BLUE" ;;
      *)
        type_color="$DIM" ;;
    esac

    # Format: timestamp  task_id  event_type  summary
    local task_str=""
    if [ -n "$etask" ]; then
      task_str="$etask"
    else
      task_str="—"
    fi

    printf '  %s%-16s%s  %s%-6s%s  %s%-12s%s  %s\n' \
      "$DIM" "$ts_display" "$RESET" \
      "$DIM" "$task_str" "$RESET" \
      "$type_color" "$etype" "$RESET" \
      "$esummary"
  done <<EOF
$rows
EOF
  IFS="$old_ifs"
  printf '\n'
}

grove_help_log() {
  printf 'Usage: grove log [TASK_ID] [OPTIONS]\n\n'
  printf 'Show event timeline.\n\n'
  printf 'Arguments:\n'
  printf '  TASK_ID         Show events for a specific task\n\n'
  printf 'Options:\n'
  printf '  --repo REPO     Filter by repo\n'
  printf '  --type TYPE     Filter by event type\n'
  printf '  --limit N       Show N events (default 20)\n'
  printf '  --all           Show all events\n\n'
  printf 'Event types: created, started, paused, resumed, completed,\n'
  printf '  failed, cancelled, pr_created, pr_merged, status_change\n'
}
