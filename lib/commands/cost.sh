#!/usr/bin/env bash
# lib/commands/cost.sh — grove cost
# Cost breakdown display with budget comparison.

grove_cmd_cost() {
  grove_require_db
  grove_require_config

  # Parse arguments
  local time_range="all"

  while [ $# -gt 0 ]; do
    case "$1" in
      --week)   time_range="week";  shift ;;
      --today)  time_range="today"; shift ;;
      --month)  time_range="month"; shift ;;
      *)
        grove_error "Unknown option: $1"
        return 1
        ;;
    esac
  done

  # Compute date filter and label via python3
  local date_info
  date_info=$(python3 -c "
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)
mode = '${time_range}'

if mode == 'today':
    label = 'Today (' + now.strftime('%B %-d, %Y') + ')'
    sql = \"date(created_at) = date('now')\"
    sql_sessions = \"date(started_at) = date('now')\"
elif mode == 'week':
    monday = now - timedelta(days=now.weekday())
    label = 'This week (' + monday.strftime('%B %-d') + '-' + now.strftime('%-d, %Y') + ')'
    sql = \"created_at >= date('now', 'weekday 1', '-7 days')\"
    sql_sessions = \"started_at >= date('now', 'weekday 1', '-7 days')\"
elif mode == 'month':
    first = now.replace(day=1)
    label = 'This month (' + now.strftime('%B %Y') + ')'
    sql = \"created_at >= date('now', 'start of month')\"
    sql_sessions = \"started_at >= date('now', 'start of month')\"
else:
    label = 'All time'
    sql = '1=1'
    sql_sessions = '1=1'

print(label)
print(sql)
print(sql_sessions)
")

  local date_label
  local sql_tasks
  local sql_sessions
  date_label=$(printf '%s' "$date_info" | sed -n '1p')
  sql_tasks=$(printf '%s' "$date_info" | sed -n '2p')
  sql_sessions=$(printf '%s' "$date_info" | sed -n '3p')

  # Header
  printf '\n%s%s%s\n' "$BOLD" "$date_label" "$RESET"

  # By repo
  local repo_rows
  repo_rows=$(grove_db_query "SELECT repo, COALESCE(SUM(cost_usd), 0), COUNT(*) FROM tasks WHERE $sql_tasks AND repo IS NOT NULL GROUP BY repo ORDER BY SUM(cost_usd) DESC;")

  local total_cost
  total_cost=$(grove_db_get "SELECT COALESCE(SUM(cost_usd), 0) FROM tasks WHERE $sql_tasks;")
  local total_tasks
  total_tasks=$(grove_db_get "SELECT COUNT(*) FROM tasks WHERE $sql_tasks;")

  printf '\n  %sBy repo:%s\n' "$BOLD" "$RESET"
  if [ -n "$repo_rows" ]; then
    # Find longest repo name for alignment
    local max_repo_len=0
    local old_ifs="$IFS"
    while IFS='	' read -r rname rcost rcount; do
      [ -z "$rname" ] && continue
      if [ "${#rname}" -gt "$max_repo_len" ]; then
        max_repo_len="${#rname}"
      fi
    done <<EOF
$repo_rows
EOF
    IFS="$old_ifs"
    if [ "$max_repo_len" -lt 5 ]; then
      max_repo_len=5
    fi

    local old_ifs="$IFS"
    while IFS='	' read -r rname rcost rcount; do
      [ -z "$rname" ] && continue
      local cost_fmt
      cost_fmt=$(grove_dollars "$rcost")
      printf '    %s  %s  (%s tasks)\n' "$(grove_pad "$rname" "$max_repo_len")" "$(grove_pad "$cost_fmt" 10)" "$rcount"
    done <<EOF
$repo_rows
EOF
    IFS="$old_ifs"

    # Separator and total
    local sep_len=$(( max_repo_len + 20 ))
    local sep=""
    local si=0
    while [ "$si" -lt "$sep_len" ]; do
      sep="${sep}-"
      si=$(( si + 1 ))
    done
    printf '    %s\n' "$sep"
  fi

  # Total with budget comparison
  local total_fmt
  total_fmt=$(grove_dollars "$total_cost")
  local week_budget
  week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")

  if [ "$time_range" = "week" ]; then
    local budget_fmt
    budget_fmt=$(grove_dollars "$week_budget")
    local budget_info
    budget_info=$(python3 -c "
c = float('${total_cost}')
b = float('${week_budget}')
pct = (c / b * 100) if b > 0 else 0
print(f'{pct:.0f}')
")
    local budget_color="$GREEN"
    local pct_val="$budget_info"
    if [ "$pct_val" -ge 100 ] 2>/dev/null; then
      budget_color="$RED"
    elif [ "$pct_val" -ge 80 ] 2>/dev/null; then
      budget_color="$YELLOW"
    fi
    printf '    %sTotal       %s%s%s / %s weekly budget (%s%s%%%s)\n' \
      "$BOLD" "$budget_color" "$total_fmt" "$RESET" \
      "$budget_fmt" "$budget_color" "$pct_val" "$RESET"

    if [ "$pct_val" -ge 100 ] 2>/dev/null; then
      printf '\n  %s%sOver budget!%s\n' "$RED" "$BOLD" "$RESET"
    elif [ "$pct_val" -ge 80 ] 2>/dev/null; then
      printf '\n  %sApproaching budget limit%s\n' "$YELLOW" "$RESET"
    fi
  else
    printf '    %sTotal       %s%s\n' "$BOLD" "$total_fmt" "$RESET"
  fi

  # By strategy
  local strat_rows
  strat_rows=$(grove_db_query "SELECT strategy, COALESCE(SUM(cost_usd), 0), COUNT(*) FROM tasks WHERE $sql_tasks AND strategy IS NOT NULL AND strategy != '' GROUP BY strategy ORDER BY SUM(cost_usd) DESC;")

  printf '\n  %sBy strategy:%s\n' "$BOLD" "$RESET"
  if [ -n "$strat_rows" ]; then
    local old_ifs="$IFS"
    while IFS='	' read -r sname scost scount; do
      [ -z "$sname" ] && continue
      local cost_fmt
      cost_fmt=$(grove_dollars "$scost")
      local avg_fmt
      avg_fmt=$(python3 -c "
c = float('${scost}')
n = int('${scount}')
avg = c / n if n > 0 else 0
print(f'\${avg:.2f}')
")
      printf '    %s  %s  (%s tasks, avg %s)\n' \
        "$(grove_pad "$sname" 12)" "$(grove_pad "$cost_fmt" 10)" "$scount" "$avg_fmt"
    done <<EOF
$strat_rows
EOF
    IFS="$old_ifs"
  else
    printf '    %sNo strategy data%s\n' "$DIM" "$RESET"
  fi

  # Most expensive / cheapest
  local most_expensive
  most_expensive=$(grove_db_query "SELECT id, cost_usd, strategy FROM tasks WHERE $sql_tasks AND cost_usd > 0 ORDER BY cost_usd DESC LIMIT 1;")
  local least_expensive
  least_expensive=$(grove_db_query "SELECT id, cost_usd, strategy FROM tasks WHERE $sql_tasks AND cost_usd > 0 ORDER BY cost_usd ASC LIMIT 1;")

  if [ -n "$most_expensive" ]; then
    local me_id me_cost me_strat
    IFS='	' read -r me_id me_cost me_strat <<EOF
$most_expensive
EOF
    local me_cost_fmt
    me_cost_fmt=$(grove_dollars "${me_cost:-0}")
    printf '\n  %sMost expensive:%s %s (%s, %s)\n' "$BOLD" "$RESET" "$me_id" "$me_cost_fmt" "${me_strat:-unknown}"
  fi

  if [ -n "$least_expensive" ]; then
    local le_id le_cost le_strat
    IFS='	' read -r le_id le_cost le_strat <<EOF
$least_expensive
EOF
    local le_cost_fmt
    le_cost_fmt=$(grove_dollars "${le_cost:-0}")
    printf '  %sCheapest:%s       %s (%s, %s)\n' "$BOLD" "$RESET" "$le_id" "$le_cost_fmt" "${le_strat:-unknown}"
  fi

  if [ "$total_cost" = "0" ] && [ -z "$most_expensive" ]; then
    printf '\n  %sNo cost data recorded yet.%s\n' "$DIM" "$RESET"
  fi

  printf '\n'
}

grove_help_cost() {
  printf 'Usage: grove cost [OPTIONS]\n\n'
  printf 'Show cost breakdown by repo and strategy.\n\n'
  printf 'Options:\n'
  printf '  --today   Today only\n'
  printf '  --week    This week only\n'
  printf '  --month   This month only\n\n'
  printf 'Default is all time. Shows budget comparison for --week.\n'
}
