#!/usr/bin/env bash
# lib/commands/hud.sh — grove (no args)
# The "Monday morning" interactive dashboard.

grove_cmd_hud() {
  # Require init before showing HUD
  if [ ! -f "$GROVE_DB" ]; then
    grove_info "Welcome to Grove v$GROVE_VERSION"
    printf '\n  Run %sgrove init%s to get started.\n\n' "$BOLD" "$RESET"
    return 0
  fi

  grove_require_config

  # --- Greeting ---
  local ws_name
  ws_name=$(grove_workspace_name 2>/dev/null || echo "Grove")
  local today
  today=$(python3 -c "from datetime import datetime; print(datetime.now().strftime('%A, %B %-d'))")
  local greeting
  greeting=$(python3 -c "
from datetime import datetime
h = datetime.now().hour
if h < 12: print('Good morning')
elif h < 17: print('Good afternoon')
else: print('Good evening')
")

  printf '\n'
  printf '  %s%s%s  %s%s%s\n' "$BOLD" "$ws_name" "$RESET" "$DIM" "v$GROVE_VERSION" "$RESET"
  printf '  %s — %s\n' "$greeting" "$today"
  printf '\n'

  # --- Check total tasks ---
  local total_tasks
  total_tasks=$(grove_db_task_count "")
  if [ "$total_tasks" = "0" ]; then
    printf '  %sNo tasks yet.%s\n' "$DIM" "$RESET"
    printf '  Run %sgrove add%s or %sgrove sync%s to get started.\n\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
    grove_db_config_set "last_hud_view" "$(grove_timestamp)"
    return 0
  fi

  # --- Build interactive choices list ---
  # We use indexed arrays (bash 3.2 compat) to collect menu items
  local choice_count=0
  # Parallel arrays for choice labels and actions
  # choice_labels[N] = display text
  # choice_actions[N] = command to run
  local choice_labels_file
  choice_labels_file=$(mktemp)
  local choice_actions_file
  choice_actions_file=$(mktemp)

  # --- COMPLETED section ---
  local last_hud
  last_hud=$(grove_db_config_get "last_hud_view" 2>/dev/null || echo "")
  local completed_rows=""
  if [ -n "$last_hud" ]; then
    local escaped_last_hud
    escaped_last_hud=$(grove_db_escape "$last_hud")
    completed_rows=$(grove_db_query "SELECT id, repo, title FROM tasks WHERE status IN ('completed', 'done') AND (completed_at >= '$escaped_last_hud' OR updated_at >= '$escaped_last_hud') ORDER BY completed_at DESC LIMIT 10;")
  else
    completed_rows=$(grove_db_query "SELECT id, repo, title FROM tasks WHERE status IN ('completed', 'done') ORDER BY completed_at DESC LIMIT 10;")
  fi

  if [ -n "$completed_rows" ]; then
    printf '  %s%sCOMPLETED%s\n' "$BOLD" "$GREEN" "$RESET"
    local IFS_SAVE="$IFS"
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      printf '    %s %s%s%s  %s\n' \
        "$(grove_badge "done" "green")" \
        "$DIM" "$tid" "$RESET" \
        "$(grove_truncate "$ttitle" 50)"
    done <<EOF
$completed_rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- IN PROGRESS section ---
  local running_rows
  running_rows=$(grove_db_query "SELECT id, repo, title, status, session_summary, next_steps FROM tasks WHERE status IN ('running', 'paused') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority ASC;")

  if [ -n "$running_rows" ]; then
    printf '  %s%sIN PROGRESS%s\n' "$BOLD" "$YELLOW" "$RESET"
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle tstatus tsummary tnext; do
      [ -z "$tid" ] && continue
      local badge_color="yellow"
      if [ "$tstatus" = "running" ]; then
        badge_color="green"
      fi
      printf '    %s %s%s%s %s%s%s  %s\n' \
        "$(grove_badge "$tstatus" "$badge_color")" \
        "$DIM" "$tid" "$RESET" \
        "$DIM" "$trepo" "$RESET" \
        "$(grove_truncate "$ttitle" 44)"

      # Show last activity
      if [ -n "$tsummary" ]; then
        local short_summary
        short_summary=$(grove_truncate "$tsummary" 60)
        printf '      %sLast:%s %s\n' "$DIM" "$RESET" "$short_summary"
      else
        # Fall back to most recent event
        local last_event
        last_event=$(grove_db_get "SELECT summary FROM events WHERE task_id = '$(grove_db_escape "$tid")' ORDER BY timestamp DESC LIMIT 1;")
        if [ -n "$last_event" ]; then
          printf '      %sLast:%s %s\n' "$DIM" "$RESET" "$(grove_truncate "$last_event" 60)"
        fi
      fi

      # Show next steps
      if [ -n "$tnext" ]; then
        printf '      %sNext:%s %s\n' "$DIM" "$RESET" "$(grove_truncate "$tnext" 60)"
      fi

      # Add to menu
      if [ "$tstatus" = "paused" ]; then
        echo "Resume $tid: $ttitle" >> "$choice_labels_file"
        echo "resume $tid" >> "$choice_actions_file"
        choice_count=$(( choice_count + 1 ))
      elif [ "$tstatus" = "running" ]; then
        echo "Watch $tid: $ttitle" >> "$choice_labels_file"
        echo "watch $tid" >> "$choice_actions_file"
        choice_count=$(( choice_count + 1 ))
      fi
    done <<EOF
$running_rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- READY TO START section ---
  local ready_rows
  ready_rows=$(grove_db_query "SELECT id, repo, title, strategy, estimated_cost FROM tasks WHERE status = 'ready' ORDER BY priority ASC, created_at ASC LIMIT 10;")

  if [ -n "$ready_rows" ]; then
    printf '  %s%sREADY TO START%s\n' "$BOLD" "$BLUE" "$RESET"
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle tstrategy tcost; do
      [ -z "$tid" ] && continue
      local cost_str=""
      if [ -n "$tcost" ] && [ "$tcost" != "0" ]; then
        cost_str=" ~$(grove_dollars "$tcost")"
      fi
      local strat_str=""
      if [ -n "$tstrategy" ]; then
        strat_str=" ($tstrategy)"
      fi
      printf '    %s %s%s%s %s%s%s  %s%s%s%s%s\n' \
        "$(grove_badge "ready" "blue")" \
        "$DIM" "$tid" "$RESET" \
        "$DIM" "$trepo" "$RESET" \
        "$(grove_truncate "$ttitle" 40)" \
        "$DIM" "$strat_str" "$cost_str" "$RESET"

      # Add to menu
      echo "Start $tid: $(grove_truncate "$ttitle" 40)" >> "$choice_labels_file"
      echo "work $tid" >> "$choice_actions_file"
      choice_count=$(( choice_count + 1 ))
    done <<EOF
$ready_rows
EOF
    IFS="$old_ifs"
    printf '\n'
  fi

  # --- BLOCKED section ---
  # Tasks with depends_on that reference incomplete tasks
  local blocked_rows
  blocked_rows=$(grove_db_query "SELECT t.id, t.repo, t.title, t.depends_on FROM tasks t WHERE t.depends_on IS NOT NULL AND t.depends_on != '' AND t.status NOT IN ('completed', 'done', 'failed') ORDER BY t.priority ASC;")

  if [ -n "$blocked_rows" ]; then
    local has_blocked=0
    local blocked_output=""
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle tdeps; do
      [ -z "$tid" ] && continue
      [ -z "$tdeps" ] && continue
      # Check if any dependency is not completed/done
      local is_blocked=0
      local dep
      # Split comma-separated deps
      local saved_ifs="$IFS"
      IFS=","
      for dep in $tdeps; do
        # Trim whitespace
        dep=$(printf '%s' "$dep" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -z "$dep" ] && continue
        local dep_status
        dep_status=$(grove_db_task_status "$dep" 2>/dev/null || echo "")
        if [ "$dep_status" != "completed" ] && [ "$dep_status" != "done" ]; then
          is_blocked=1
          break
        fi
      done
      IFS="$saved_ifs"

      if [ "$is_blocked" = "1" ]; then
        has_blocked=1
        blocked_output="${blocked_output}    $(grove_badge "blocked" "red") ${DIM}${tid}${RESET} ${DIM}${trepo}${RESET}  $(grove_truncate "$ttitle" 44)
      ${DIM}Waiting on: ${tdeps}${RESET}
"
      fi
    done <<EOF
$blocked_rows
EOF
    IFS="$old_ifs"

    if [ "$has_blocked" = "1" ]; then
      printf '  %s%sBLOCKED%s\n' "$BOLD" "$RED" "$RESET"
      printf '%s' "$blocked_output"
      printf '\n'
    fi
  fi

  # --- Queued counts ---
  local ingested_count
  ingested_count=$(grove_db_task_count "ingested")
  local planned_count
  planned_count=$(grove_db_task_count "planned")
  local review_count
  review_count=$(grove_db_task_count "review")

  if [ "$ingested_count" -gt 0 ] 2>/dev/null || [ "$planned_count" -gt 0 ] 2>/dev/null || [ "$review_count" -gt 0 ] 2>/dev/null; then
    printf '  %sQueued:%s' "$DIM" "$RESET"
    if [ "$ingested_count" -gt 0 ] 2>/dev/null; then
      printf ' %s ingested' "$ingested_count"
    fi
    if [ "$planned_count" -gt 0 ] 2>/dev/null; then
      printf ' %s planned' "$planned_count"
    fi
    if [ "$review_count" -gt 0 ] 2>/dev/null; then
      printf ' %s awaiting review' "$review_count"
    fi
    printf '\n'
  fi

  # --- Budget line ---
  local week_cost
  week_cost=$(grove_db_cost_week)
  local week_budget
  week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")
  local budget_color="$GREEN"
  local over_budget=0
  over_budget=$(python3 -c "
c = float('${week_cost}')
b = float('${week_budget}')
if c > b * 0.9: print('red')
elif c > b * 0.7: print('yellow')
else: print('green')
")
  budget_color=""
  case "$over_budget" in
    red)    budget_color="$RED" ;;
    yellow) budget_color="$YELLOW" ;;
    green)  budget_color="$GREEN" ;;
  esac

  printf '  %sBudget:%s %s%s%s / %s this week\n' \
    "$DIM" "$RESET" \
    "$budget_color" "$(grove_dollars "$week_cost")" "$RESET" \
    "$(grove_dollars "$week_budget")"
  printf '\n'

  # --- Add review PRs option if there are tasks in review ---
  if [ "$review_count" -gt 0 ] 2>/dev/null; then
    echo "Review PRs ($review_count pending)" >> "$choice_labels_file"
    echo "review" >> "$choice_actions_file"
    choice_count=$(( choice_count + 1 ))
  fi

  # --- Add plan option if there are ingested tasks ---
  if [ "$ingested_count" -gt 0 ] 2>/dev/null; then
    echo "Plan ingested tasks ($ingested_count)" >> "$choice_labels_file"
    echo "plan" >> "$choice_actions_file"
    choice_count=$(( choice_count + 1 ))
  fi

  # --- Update last_hud_view ---
  grove_db_config_set "last_hud_view" "$(grove_timestamp)"

  # --- Interactive choices ---
  if [ "$choice_count" = "0" ]; then
    # Nothing actionable
    printf '  %sNothing actionable right now.%s\n' "$DIM" "$RESET"
    printf '  Run %sgrove add%s or %sgrove sync%s to bring in work.\n\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
    rm -f "$choice_labels_file" "$choice_actions_file"
    return 0
  fi

  # Check if stdin is a terminal for interactive mode
  if [ ! -t 0 ]; then
    rm -f "$choice_labels_file" "$choice_actions_file"
    return 0
  fi

  # Show numbered choices
  printf '  %sWhat next?%s\n' "$BOLD" "$RESET"
  local i=1
  while IFS= read -r label; do
    printf '    %s[%d]%s %s\n' "$BOLD" "$i" "$RESET" "$label"
    i=$(( i + 1 ))
  done < "$choice_labels_file"
  printf '    %s[q]%s Quit\n' "$BOLD" "$RESET"
  printf '\n'

  # Read selection
  local selection
  printf '  Choice: '
  read -r selection

  if [ -z "$selection" ] || [ "$selection" = "q" ] || [ "$selection" = "Q" ]; then
    rm -f "$choice_labels_file" "$choice_actions_file"
    return 0
  fi

  # Validate numeric input
  if ! printf '%s' "$selection" | grep -q '^[0-9][0-9]*$'; then
    rm -f "$choice_labels_file" "$choice_actions_file"
    return 0
  fi

  if [ "$selection" -lt 1 ] 2>/dev/null || [ "$selection" -gt "$choice_count" ] 2>/dev/null; then
    grove_warn "Invalid choice."
    rm -f "$choice_labels_file" "$choice_actions_file"
    return 0
  fi

  # Get the action for the selected choice
  local action
  action=$(sed -n "${selection}p" "$choice_actions_file")
  rm -f "$choice_labels_file" "$choice_actions_file"

  if [ -z "$action" ]; then
    return 0
  fi

  # Dispatch the action
  printf '\n'
  local action_cmd
  action_cmd=$(printf '%s' "$action" | cut -d' ' -f1)
  local action_args
  action_args=$(printf '%s' "$action" | cut -d' ' -f2-)

  local func_name="grove_cmd_${action_cmd}"
  if type "$func_name" >/dev/null 2>&1; then
    if [ -n "$action_args" ] && [ "$action_args" != "$action_cmd" ]; then
      "$func_name" $action_args
    else
      "$func_name"
    fi
  else
    grove_warn "Command not yet implemented: $action_cmd"
  fi
}

grove_help_hud() {
  printf 'Usage: grove\n\n'
  printf 'Show the interactive HUD (Heads-Up Display).\n\n'
  printf 'The HUD is the default command when you run grove with no arguments.\n'
  printf 'It shows:\n'
  printf '  - Recently completed tasks\n'
  printf '  - In-progress and paused tasks\n'
  printf '  - Tasks ready to start\n'
  printf '  - Blocked tasks\n'
  printf '  - Budget summary\n'
  printf '  - Interactive menu to resume, start, or review work\n\n'
  printf 'For a non-interactive summary, use: grove status\n'
}
