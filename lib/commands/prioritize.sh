#!/usr/bin/env bash
# lib/commands/prioritize.sh — grove prioritize
# Interactive task priority reordering.

grove_cmd_prioritize() {
  grove_require_db

  if [ ! -t 0 ]; then
    grove_die "Prioritize requires an interactive terminal."
  fi

  grove_header "Prioritize Tasks"

  # Load non-completed tasks sorted by priority
  local sql="SELECT id, repo, title, status, priority FROM tasks WHERE status != 'completed' ORDER BY priority ASC, created_at ASC;"
  local rows
  rows=$(grove_db_query "$sql")

  if [ -z "$rows" ]; then
    grove_info "No tasks to prioritize."
    return 0
  fi

  # Load into indexed arrays
  local task_ids=()
  local task_repos=()
  local task_titles=()
  local task_statuses=()
  local task_priorities=()

  local IFS_SAVE="$IFS"
  while IFS='	' read -r id repo title status priority; do
    [ -z "$id" ] && continue
    task_ids=("${task_ids[@]}" "$id")
    task_repos=("${task_repos[@]}" "$repo")
    task_titles=("${task_titles[@]}" "$title")
    task_statuses=("${task_statuses[@]}" "$status")
    task_priorities=("${task_priorities[@]}" "$priority")
  done << EOF
$rows
EOF
  IFS="$IFS_SAVE"

  local count=${#task_ids[@]}
  if [ "$count" -eq 0 ]; then
    grove_info "No tasks to prioritize."
    return 0
  fi

  local dirty=0

  _grove_prioritize_show() {
    printf '\n'
    printf '%s  #   ID       REPO         TITLE                          PRI   STATUS%s\n' "$BOLD" "$RESET"
    printf '  ─── ──────── ──────────── ────────────────────────────── ───── ────────────\n'
    local i=0
    while [ "$i" -lt "$count" ]; do
      local num=$(( i + 1 ))
      local display_title
      display_title=$(grove_truncate "${task_titles[$i]}" 28)
      printf '  %-3d %-8s %-12s %-30s %-5s %s\n' \
        "$num" "${task_ids[$i]}" "${task_repos[$i]}" "$display_title" "${task_priorities[$i]}" "${task_statuses[$i]}"
      i=$(( i + 1 ))
    done
    printf '\n'
    printf '%sCommands:%s move N up | move N down | set N priority P | done%s\n' "$DIM" "$RESET" "$RESET"
  }

  _grove_prioritize_show

  while true; do
    printf '> '
    local input
    read -r input
    if [ -z "$input" ]; then
      continue
    fi

    # Parse commands
    case "$input" in
      done|quit|q|exit)
        break
        ;;
      help|h|\?)
        printf '\n  move N up       Move task #N up one position\n'
        printf '  move N down     Move task #N down one position\n'
        printf '  set N priority P  Set task #N priority to P (1-100)\n'
        printf '  show            Redisplay the list\n'
        printf '  done            Save and exit\n\n'
        ;;
      show|list|ls)
        _grove_prioritize_show
        ;;
      move\ *\ up)
        local num
        num=$(printf '%s' "$input" | python3 -c "import sys; parts=sys.stdin.read().split(); print(parts[1])")
        if [ -z "$num" ] || ! printf '%s' "$num" | grep -q '^[0-9]*$'; then
          grove_warn "Invalid: $input"
          continue
        fi
        local idx=$(( num - 1 ))
        if [ "$idx" -lt 1 ] || [ "$idx" -ge "$count" ]; then
          grove_warn "Cannot move #$num up."
          continue
        fi
        # Swap with previous
        local prev=$(( idx - 1 ))
        local tmp_id="${task_ids[$idx]}"
        local tmp_repo="${task_repos[$idx]}"
        local tmp_title="${task_titles[$idx]}"
        local tmp_status="${task_statuses[$idx]}"
        local tmp_pri="${task_priorities[$idx]}"

        task_ids[$idx]="${task_ids[$prev]}"
        task_repos[$idx]="${task_repos[$prev]}"
        task_titles[$idx]="${task_titles[$prev]}"
        task_statuses[$idx]="${task_statuses[$prev]}"
        task_priorities[$idx]="${task_priorities[$prev]}"

        task_ids[$prev]="$tmp_id"
        task_repos[$prev]="$tmp_repo"
        task_titles[$prev]="$tmp_title"
        task_statuses[$prev]="$tmp_status"
        task_priorities[$prev]="$tmp_pri"

        dirty=1
        grove_info "Moved ${task_ids[$prev]} up."
        _grove_prioritize_show
        ;;
      move\ *\ down)
        local num
        num=$(printf '%s' "$input" | python3 -c "import sys; parts=sys.stdin.read().split(); print(parts[1])")
        if [ -z "$num" ] || ! printf '%s' "$num" | grep -q '^[0-9]*$'; then
          grove_warn "Invalid: $input"
          continue
        fi
        local idx=$(( num - 1 ))
        local next=$(( idx + 1 ))
        if [ "$idx" -lt 0 ] || [ "$next" -ge "$count" ]; then
          grove_warn "Cannot move #$num down."
          continue
        fi
        # Swap with next
        local tmp_id="${task_ids[$idx]}"
        local tmp_repo="${task_repos[$idx]}"
        local tmp_title="${task_titles[$idx]}"
        local tmp_status="${task_statuses[$idx]}"
        local tmp_pri="${task_priorities[$idx]}"

        task_ids[$idx]="${task_ids[$next]}"
        task_repos[$idx]="${task_repos[$next]}"
        task_titles[$idx]="${task_titles[$next]}"
        task_statuses[$idx]="${task_statuses[$next]}"
        task_priorities[$idx]="${task_priorities[$next]}"

        task_ids[$next]="$tmp_id"
        task_repos[$next]="$tmp_repo"
        task_titles[$next]="$tmp_title"
        task_statuses[$next]="$tmp_status"
        task_priorities[$next]="$tmp_pri"

        dirty=1
        grove_info "Moved ${task_ids[$next]} down."
        _grove_prioritize_show
        ;;
      set\ *\ priority\ *)
        local num pri
        num=$(printf '%s' "$input" | python3 -c "import sys; parts=sys.stdin.read().split(); print(parts[1])")
        pri=$(printf '%s' "$input" | python3 -c "import sys; parts=sys.stdin.read().split(); print(parts[3])")
        if [ -z "$num" ] || [ -z "$pri" ]; then
          grove_warn "Usage: set N priority P"
          continue
        fi
        if ! printf '%s' "$num" | grep -q '^[0-9]*$' || ! printf '%s' "$pri" | grep -q '^[0-9]*$'; then
          grove_warn "N and P must be numbers."
          continue
        fi
        local idx=$(( num - 1 ))
        if [ "$idx" -lt 0 ] || [ "$idx" -ge "$count" ]; then
          grove_warn "Task #$num does not exist."
          continue
        fi
        if [ "$pri" -lt 1 ] || [ "$pri" -gt 100 ]; then
          grove_warn "Priority must be 1-100."
          continue
        fi
        task_priorities[$idx]="$pri"
        dirty=1
        grove_info "Set ${task_ids[$idx]} priority to $pri."
        _grove_prioritize_show
        ;;
      *)
        grove_warn "Unknown command. Type 'help' for options."
        ;;
    esac
  done

  # Save priorities
  if [ "$dirty" -eq 1 ]; then
    local i=0
    # Assign positional priorities based on order (10, 20, 30, ...)
    # unless an explicit priority was set
    local any_explicit=0
    while [ "$i" -lt "$count" ]; do
      local positional_pri=$(( (i + 1) * 10 ))
      local id="${task_ids[$i]}"
      local pri="${task_priorities[$i]}"
      # If user set an explicit priority, use it; otherwise use positional
      grove_db_task_set "$id" "priority" "$pri"
      i=$(( i + 1 ))
    done
    grove_db_event "" "prioritized" "Reprioritized $count tasks"
    grove_success "Priorities saved."
  else
    grove_info "No changes made."
  fi
}

grove_help_prioritize() {
  printf 'Usage: grove prioritize\n\n'
  printf 'Interactive priority reordering of active tasks.\n\n'
  printf 'Shows all non-completed tasks sorted by current priority.\n'
  printf 'Use commands to reorder:\n\n'
  printf '  move N up         Move task #N up one position\n'
  printf '  move N down       Move task #N down one position\n'
  printf '  set N priority P  Set task #N priority to P (1-100)\n'
  printf '  show              Redisplay the list\n'
  printf '  done              Save changes and exit\n\n'
  printf 'Lower priority numbers sort first (1 = highest priority).\n'
}
