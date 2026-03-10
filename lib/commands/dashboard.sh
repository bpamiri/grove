#!/usr/bin/env bash
# lib/commands/dashboard.sh — grove dashboard
# Live-refreshing dashboard showing active workers, spend, events, and queue.

grove_cmd_dashboard() {
  grove_require_db

  # Trap for clean exit
  trap '_grove_dashboard_exit' INT TERM

  local refresh=5

  while true; do
    _grove_dashboard_draw

    # Wait for keypress or timeout (timeout IS the refresh interval)
    local key=""
    read -t "$refresh" -n 1 -s key 2>/dev/null || true

    case "$key" in
      q|Q)
        _grove_dashboard_exit
        return 0
        ;;
      w|W)
        _grove_dashboard_prompt_watch
        ;;
      p|P)
        _grove_dashboard_prompt_pause
        ;;
      m|M)
        _grove_dashboard_prompt_msg
        ;;
      "")
        # Timeout — just refresh
        ;;
    esac
  done
}

# Clean exit from dashboard
_grove_dashboard_exit() {
  # Show cursor, clear alternate screen artifacts
  if command -v tput >/dev/null 2>&1; then
    tput cnorm 2>/dev/null
  fi
  printf '\n'
  trap - INT TERM
}

# Draw the full dashboard
_grove_dashboard_draw() {
  # Clear screen
  if command -v tput >/dev/null 2>&1; then
    tput clear 2>/dev/null
  else
    printf '\033[2J\033[H'
  fi

  local cols=80
  if command -v tput >/dev/null 2>&1; then
    cols=$(tput cols 2>/dev/null || echo 80)
  fi

  # Header
  printf '%s%s GROVE DASHBOARD %s' "$BOLD" "$GREEN" "$RESET"
  printf '  %srefresh: 5s%s\n' "$DIM" "$RESET"
  _grove_dashboard_line "$cols"

  # --- Active Workers ---
  printf '\n  %s%sACTIVE WORKERS%s\n\n' "$BOLD" "$YELLOW" "$RESET"

  local running_rows
  running_rows=$(grove_db_query "SELECT t.id, t.repo, t.strategy, t.started_at FROM tasks t WHERE t.status = 'running' ORDER BY t.started_at ASC;")

  if [ -z "$running_rows" ]; then
    printf '    %sNo active workers%s\n' "$DIM" "$RESET"
  else
    printf '    %s%-8s %-12s %-12s %-14s %s%s\n' \
      "$BOLD" "TASK" "REPO" "STRATEGY" "ELAPSED" "LAST ACTIVITY" "$RESET"

    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo tstrat tstarted; do
      [ -z "$tid" ] && continue

      # Calculate elapsed time
      local elapsed=""
      if [ -n "$tstarted" ]; then
        elapsed=$(_grove_elapsed_time "$tstarted")
      else
        elapsed="-"
      fi

      # Get last activity from events
      local esc_tid
      esc_tid=$(grove_db_escape "$tid")
      local last_activity
      last_activity=$(grove_db_get "SELECT summary FROM events WHERE task_id = '$esc_tid' ORDER BY timestamp DESC LIMIT 1;")
      if [ -z "$last_activity" ]; then
        last_activity="-"
      fi

      printf '    %-8s %-12s %-12s %-14s %s\n' \
        "$tid" \
        "$(grove_truncate "${trepo:--}" 10)" \
        "$(grove_truncate "${tstrat:--}" 10)" \
        "$elapsed" \
        "$(grove_truncate "$last_activity" 40)"
    done <<EOF
$running_rows
EOF
    IFS="$old_ifs"
  fi

  # --- Session Spend ---
  printf '\n'
  _grove_dashboard_line "$cols"
  printf '\n  %s%sSESSION SPEND%s\n\n' "$BOLD" "$BLUE" "$RESET"

  local today_cost
  today_cost=$(grove_db_cost_today)
  local week_cost
  week_cost=$(grove_db_cost_week)
  local daily_limit
  daily_limit=$(grove_budget_get "per_day" 2>/dev/null || echo "25.00")
  local weekly_limit
  weekly_limit=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")

  printf '    Today:  %s / %s  ' \
    "$(grove_dollars "$today_cost")" \
    "$(grove_dollars "$daily_limit")"
  _grove_progress_bar "$today_cost" "$daily_limit" 24
  printf '\n'

  printf '    Week:   %s / %s  ' \
    "$(grove_dollars "$week_cost")" \
    "$(grove_dollars "$weekly_limit")"
  _grove_progress_bar "$week_cost" "$weekly_limit" 24
  printf '\n'

  # --- Recent Events ---
  printf '\n'
  _grove_dashboard_line "$cols"
  printf '\n  %s%sRECENT EVENTS%s\n\n' "$BOLD" "$GREEN" "$RESET"

  local event_rows
  event_rows=$(grove_db_query "SELECT timestamp, task_id, summary FROM events ORDER BY timestamp DESC LIMIT 10;")

  if [ -z "$event_rows" ]; then
    printf '    %sNo events yet%s\n' "$DIM" "$RESET"
  else
    local old_ifs="$IFS"
    while IFS='	' read -r ets etask esummary; do
      [ -z "$ets" ] && continue
      local rel_time
      rel_time=$(grove_relative_time "$ets" 2>/dev/null || echo "$ets")
      local task_str=""
      if [ -n "$etask" ]; then
        task_str="$etask "
      fi
      printf '    %s%-16s%s %s%s%s %s\n' \
        "$DIM" "$rel_time" "$RESET" \
        "$BLUE" "$task_str" "$RESET" \
        "$(grove_truncate "$esummary" 50)"
    done <<EOF
$event_rows
EOF
    IFS="$old_ifs"
  fi

  # --- Queue ---
  printf '\n'
  _grove_dashboard_line "$cols"
  printf '\n  %s%sQUEUE%s\n\n' "$BOLD" "$YELLOW" "$RESET"

  local ready_count
  ready_count=$(grove_db_task_count "ready")

  if [ "$ready_count" -gt 0 ] 2>/dev/null; then
    printf '    %s task(s) ready\n' "$ready_count"

    local ready_rows
    ready_rows=$(grove_db_query "SELECT id, title FROM tasks WHERE status = 'ready' ORDER BY priority ASC, created_at ASC LIMIT 5;")

    local old_ifs="$IFS"
    while IFS='	' read -r tid ttitle; do
      [ -z "$tid" ] && continue
      printf '      %s%-6s%s %s\n' "$DIM" "$tid" "$RESET" "$(grove_truncate "$ttitle" 50)"
    done <<EOF
$ready_rows
EOF
    IFS="$old_ifs"

    if [ "$ready_count" -gt 5 ] 2>/dev/null; then
      local remaining=$(( ready_count - 5 ))
      printf '      %s... and %d more%s\n' "$DIM" "$remaining" "$RESET"
    fi
  else
    printf '    %sNo tasks queued%s\n' "$DIM" "$RESET"
  fi

  # --- Keyboard shortcuts ---
  printf '\n'
  _grove_dashboard_line "$cols"
  printf '\n  %s[q]%s quit  %s[w]%s watch  %s[p]%s pause  %s[m]%s message\n' \
    "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET"
}

# Draw a horizontal line
_grove_dashboard_line() {
  local width="${1:-80}"
  if [ "$width" -gt 80 ] 2>/dev/null; then
    width=80
  fi
  local i=0
  printf '  %s' "$DIM"
  while [ "$i" -lt "$width" ]; do
    printf '-'
    i=$(( i + 1 ))
  done
  printf '%s\n' "$RESET"
}

# Progress bar: _grove_progress_bar CURRENT MAX [WIDTH]
# Example output: [████████░░░░░░░░] 45%
_grove_progress_bar() {
  local current="$1"
  local max="$2"
  local width="${3:-30}"

  python3 -c "
import sys
current = float('$current')
mx = float('$max')
width = int('$width')
if mx <= 0:
    pct = 0.0
else:
    pct = min(current / mx, 1.0)
filled = int(pct * width)
empty = width - filled
# Color: green if <70%, yellow if <90%, red if >=90%
if pct >= 0.9:
    color = '\033[0;31m'
elif pct >= 0.7:
    color = '\033[0;33m'
else:
    color = '\033[0;32m'
reset = '\033[0m'
bar = '\xe2\x96\x88' * filled + '\xe2\x96\x91' * empty
pct_str = f'{pct*100:.0f}%'
sys.stdout.write(f'{color}[{bar}]{reset} {pct_str}')
"
}

# Calculate elapsed time from an ISO timestamp to now
_grove_elapsed_time() {
  local started="$1"
  python3 -c "
import sys
from datetime import datetime, timezone

ts = sys.argv[1].replace('Z', '+00:00')
try:
    dt = datetime.fromisoformat(ts)
except ValueError:
    dt = datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
diff = now - dt
total_secs = int(diff.total_seconds())
if total_secs < 0:
    print('0s')
elif total_secs < 60:
    print(f'{total_secs}s')
elif total_secs < 3600:
    m = total_secs // 60
    s = total_secs % 60
    print(f'{m}m {s}s')
elif total_secs < 86400:
    h = total_secs // 3600
    m = (total_secs % 3600) // 60
    print(f'{h}h {m}m')
else:
    d = total_secs // 86400
    h = (total_secs % 86400) // 3600
    print(f'{d}d {h}h')
" "$started"
}

# Prompt to watch a task from within the dashboard
_grove_dashboard_prompt_watch() {
  printf '\n  Task ID to watch: '
  local tid=""
  read -r tid
  if [ -n "$tid" ]; then
    # Exit dashboard and run watch
    _grove_dashboard_exit
    grove_cmd_watch "$tid"
    exit $?
  fi
}

# Prompt to pause a task from within the dashboard
_grove_dashboard_prompt_pause() {
  printf '\n  Task ID to pause: '
  local tid=""
  read -r tid
  if [ -n "$tid" ]; then
    if type grove_cmd_pause >/dev/null 2>&1; then
      grove_cmd_pause "$tid"
    else
      # Fallback: set status directly
      local status
      status=$(grove_db_task_status "$tid" 2>/dev/null)
      if [ "$status" = "running" ]; then
        grove_db_task_set_status "$tid" "paused"
        grove_success "Paused $tid"
      else
        grove_warn "Task $tid is not running (status: $status)"
      fi
    fi
    # Brief pause so user can read the output before redraw
    read -t 2 -n 1 -s 2>/dev/null || true
  fi
}

# Prompt to send a message from within the dashboard
_grove_dashboard_prompt_msg() {
  printf '\n  Task ID: '
  local tid=""
  read -r tid
  if [ -n "$tid" ]; then
    printf '  Message: '
    local msg=""
    read -r msg
    if [ -n "$msg" ]; then
      grove_cmd_msg "$tid" "$msg"
      # Brief pause so user can read the output before redraw
      read -t 2 -n 1 -s 2>/dev/null || true
    fi
  fi
}

grove_help_dashboard() {
  printf 'Usage: grove dashboard\n\n'
  printf 'Live-refreshing dashboard showing all active workers.\n\n'
  printf 'Displays:\n'
  printf '  - Active workers with elapsed time and last activity\n'
  printf '  - Session spend with progress bars (today + week)\n'
  printf '  - Last 10 events\n'
  printf '  - Queue of ready tasks\n\n'
  printf 'Keyboard shortcuts:\n'
  printf '  q    Quit dashboard\n'
  printf '  w    Watch a task (prompts for ID)\n'
  printf '  p    Pause a task (prompts for ID)\n'
  printf '  m    Send a message (prompts for ID and text)\n\n'
  printf 'The display refreshes every 5 seconds.\n'
}
