#!/usr/bin/env bash
# lib/commands/report.sh — grove report
# Generate markdown activity summary.

grove_cmd_report() {
  grove_require_db
  grove_require_config

  # Parse arguments
  local time_range="all"
  local output_file=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --week)   time_range="week";  shift ;;
      --today)  time_range="today"; shift ;;
      --output) output_file="$2";   shift 2 ;;
      --output=*) output_file="${1#--output=}"; shift ;;
      *)
        grove_error "Unknown option: $1"
        return 1
        ;;
    esac
  done

  # Build date filter SQL and human-readable range via python3
  local date_info
  date_info=$(python3 -c "
from datetime import datetime, timedelta, timezone
import sys

now = datetime.now(timezone.utc)
mode = sys.argv[1]

if mode == 'today':
    start = now.strftime('%Y-%m-%d')
    label = now.strftime('%B %-d, %Y')
    sql_where = \"date(created_at) = date('now')\"
    sql_completed = \"date(completed_at) = date('now')\"
    sql_sessions = \"date(started_at) = date('now')\"
    sql_events = \"date(timestamp) = date('now')\"
elif mode == 'week':
    # Monday of this week
    monday = now - timedelta(days=now.weekday())
    start = monday.strftime('%Y-%m-%d')
    end = now.strftime('%Y-%m-%d')
    label = monday.strftime('%B %-d') + ' - ' + now.strftime('%-d, %Y')
    sql_where = \"created_at >= date('now', 'weekday 1', '-7 days')\"
    sql_completed = \"completed_at >= date('now', 'weekday 1', '-7 days')\"
    sql_sessions = \"started_at >= date('now', 'weekday 1', '-7 days')\"
    sql_events = \"timestamp >= date('now', 'weekday 1', '-7 days')\"
else:
    label = 'All Time'
    sql_where = '1=1'
    sql_completed = '1=1'
    sql_sessions = '1=1'
    sql_events = '1=1'

print(label)
print(sql_where)
print(sql_completed)
print(sql_sessions)
print(sql_events)
" "$time_range")

  local date_label
  local sql_created
  local sql_completed
  local sql_sessions
  local sql_events
  date_label=$(printf '%s' "$date_info" | sed -n '1p')
  sql_created=$(printf '%s' "$date_info" | sed -n '2p')
  sql_completed=$(printf '%s' "$date_info" | sed -n '3p')
  sql_sessions=$(printf '%s' "$date_info" | sed -n '4p')
  sql_events=$(printf '%s' "$date_info" | sed -n '5p')

  # Gather summary counts
  local tasks_completed
  tasks_completed=$(grove_db_get "SELECT COUNT(*) FROM tasks WHERE status IN ('completed', 'done') AND $sql_completed;")
  local tasks_in_progress
  tasks_in_progress=$(grove_db_get "SELECT COUNT(*) FROM tasks WHERE status IN ('running', 'paused', 'review') AND $sql_created;")
  local tasks_created
  tasks_created=$(grove_db_get "SELECT COUNT(*) FROM tasks WHERE $sql_created;")
  local total_cost
  total_cost=$(grove_db_get "SELECT COALESCE(SUM(cost_usd), 0) FROM tasks WHERE $sql_created;")
  local total_cost_fmt
  total_cost_fmt=$(python3 -c "print(f'\${float(\"${total_cost}\"):.2f}')")

  # Build markdown output
  local md=""
  md="# Grove Report — ${date_label}

## Summary
- Tasks completed: ${tasks_completed}
- Tasks in progress: ${tasks_in_progress}
- Tasks created: ${tasks_created}
- Total cost: ${total_cost_fmt}

## Completed Tasks
| Task | Repo | Title | Strategy | Cost | Time |
|------|------|-------|----------|------|------|"

  local completed_rows
  completed_rows=$(grove_db_query "SELECT id, repo, title, strategy, cost_usd, time_minutes FROM tasks WHERE status IN ('completed', 'done') AND $sql_completed ORDER BY completed_at DESC;")

  if [ -n "$completed_rows" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle tstrat tcost ttime; do
      [ -z "$tid" ] && continue
      local cost_fmt
      cost_fmt=$(python3 -c "print(f'\${float(\"${tcost:-0}\"):.2f}')")
      local time_fmt
      time_fmt=$(python3 -c "
m = float('${ttime:-0}')
if m < 1:
    print('<1m')
elif m < 60:
    print(f'{int(m)}m')
else:
    h = int(m // 60)
    rm = int(m % 60)
    print(f'{h}h {rm}m')
")
      md="${md}
| ${tid} | ${trepo} | ${ttitle} | ${tstrat:-—} | ${cost_fmt} | ${time_fmt} |"
    done <<EOF
$completed_rows
EOF
    IFS="$old_ifs"
  else
    md="${md}
| — | — | No completed tasks | — | — | — |"
  fi

  # In Progress
  md="${md}

## In Progress
| Task | Repo | Title | Status | Cost So Far |
|------|------|-------|--------|-------------|"

  local progress_rows
  progress_rows=$(grove_db_query "SELECT id, repo, title, status, cost_usd FROM tasks WHERE status IN ('running', 'paused', 'review') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, priority ASC;")

  if [ -n "$progress_rows" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle tstatus tcost; do
      [ -z "$tid" ] && continue
      local cost_fmt
      cost_fmt=$(python3 -c "print(f'\${float(\"${tcost:-0}\"):.2f}')")
      md="${md}
| ${tid} | ${trepo} | ${ttitle} | ${tstatus} | ${cost_fmt} |"
    done <<EOF
$progress_rows
EOF
    IFS="$old_ifs"
  else
    md="${md}
| — | — | No tasks in progress | — | — |"
  fi

  # Cost Summary
  md="${md}

## Cost Summary"

  # By repo
  local repo_costs
  repo_costs=$(grove_db_query "SELECT repo, SUM(cost_usd), COUNT(*) FROM tasks WHERE $sql_created AND repo IS NOT NULL GROUP BY repo ORDER BY SUM(cost_usd) DESC;")

  md="${md}
### By Repo"
  if [ -n "$repo_costs" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r rname rcost rcount; do
      [ -z "$rname" ] && continue
      local cost_fmt
      cost_fmt=$(python3 -c "print(f'\${float(\"${rcost:-0}\"):.2f}')")
      md="${md}
- ${rname}: ${cost_fmt} (${rcount} tasks)"
    done <<EOF
$repo_costs
EOF
    IFS="$old_ifs"
  else
    md="${md}
- No cost data"
  fi

  # By strategy
  local strat_costs
  strat_costs=$(grove_db_query "SELECT strategy, SUM(cost_usd), COUNT(*) FROM tasks WHERE $sql_created AND strategy IS NOT NULL AND strategy != '' GROUP BY strategy ORDER BY SUM(cost_usd) DESC;")

  md="${md}

### By Strategy"
  if [ -n "$strat_costs" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r sname scost scount; do
      [ -z "$sname" ] && continue
      local cost_fmt
      cost_fmt=$(python3 -c "print(f'\${float(\"${scost:-0}\"):.2f}')")
      md="${md}
- ${sname}: ${cost_fmt} (${scount} tasks)"
    done <<EOF
$strat_costs
EOF
    IFS="$old_ifs"
  else
    md="${md}
- No strategy data"
  fi

  # Most/least expensive
  local most_expensive
  most_expensive=$(grove_db_query "SELECT id, cost_usd, strategy FROM tasks WHERE $sql_created AND cost_usd > 0 ORDER BY cost_usd DESC LIMIT 1;")
  local least_expensive
  least_expensive=$(grove_db_query "SELECT id, cost_usd, strategy FROM tasks WHERE $sql_created AND cost_usd > 0 ORDER BY cost_usd ASC LIMIT 1;")

  if [ -n "$most_expensive" ]; then
    local me_id me_cost me_strat
    IFS='	' read -r me_id me_cost me_strat <<EOF
$most_expensive
EOF
    local me_cost_fmt
    me_cost_fmt=$(python3 -c "print(f'\${float(\"${me_cost:-0}\"):.2f}')")
    md="${md}

- **Most expensive:** ${me_id} (${me_cost_fmt}, ${me_strat:-unknown})"
  fi

  if [ -n "$least_expensive" ]; then
    local le_id le_cost le_strat
    IFS='	' read -r le_id le_cost le_strat <<EOF
$least_expensive
EOF
    local le_cost_fmt
    le_cost_fmt=$(python3 -c "print(f'\${float(\"${le_cost:-0}\"):.2f}')")
    md="${md}
- **Cheapest:** ${le_id} (${le_cost_fmt}, ${le_strat:-unknown})"
  fi

  # Recent Events
  md="${md}

## Recent Events"

  local event_rows
  event_rows=$(grove_db_query "SELECT timestamp, task_id, event_type, summary FROM events WHERE $sql_events ORDER BY timestamp DESC LIMIT 20;")

  if [ -n "$event_rows" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r ets etask etype esummary; do
      [ -z "$ets" ] && continue
      local task_str=""
      if [ -n "$etask" ]; then
        task_str=" ${etask}:"
      fi
      md="${md}
- ${ets}${task_str} ${esummary}"
    done <<EOF
$event_rows
EOF
    IFS="$old_ifs"
  else
    md="${md}
- No events in this period"
  fi

  md="${md}
"

  # Output
  if [ -n "$output_file" ]; then
    printf '%s\n' "$md" > "$output_file"
    grove_success "Report written to $output_file"
  else
    printf '%s\n' "$md"
  fi
}

grove_help_report() {
  printf 'Usage: grove report [OPTIONS]\n\n'
  printf 'Generate a markdown activity summary.\n\n'
  printf 'Options:\n'
  printf '  --today         Today only\n'
  printf '  --week          This week only\n'
  printf '  --output FILE   Write to file instead of stdout\n\n'
  printf 'Default is all time. Output is valid markdown.\n'
}
