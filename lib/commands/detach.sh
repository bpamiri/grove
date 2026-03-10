#!/usr/bin/env bash
# lib/commands/detach.sh — grove detach
# Inform user that a worker continues in background.

grove_cmd_detach() {
  grove_require_db

  local detach_all=0
  local task_id=""

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --all|-a)
        detach_all=1
        shift
        ;;
      -h|--help)
        grove_help_detach
        return 0
        ;;
      *)
        task_id="$1"
        shift
        ;;
    esac
  done

  # Detach all running tasks
  if [ "$detach_all" = "1" ]; then
    local rows
    rows=$(grove_db_tasks_by_status "running")

    if [ -z "$rows" ]; then
      grove_info "No running tasks to detach."
      return 0
    fi

    local count=0
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      _grove_detach_task "$tid" "$ttitle"
      count=$(( count + 1 ))
    done <<EOF
$rows
EOF
    IFS="$old_ifs"

    grove_success "Detached $count task(s)."
    return 0
  fi

  # Detach specific task or current foreground task
  if [ -z "$task_id" ]; then
    # Try to find a single running task
    local running_rows
    running_rows=$(grove_db_tasks_by_status "running")
    local running_count=0
    local first_id=""
    local first_title=""
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      running_count=$(( running_count + 1 ))
      if [ "$running_count" -eq 1 ]; then
        first_id="$tid"
        first_title="$ttitle"
      fi
    done <<EOF
$running_rows
EOF
    IFS="$old_ifs"

    if [ "$running_count" -eq 0 ]; then
      grove_die "No running tasks to detach."
    elif [ "$running_count" -eq 1 ]; then
      task_id="$first_id"
    else
      grove_die "Multiple running tasks. Specify a task ID or use --all."
    fi
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Verify task is running
  local status
  status=$(grove_db_task_status "$task_id")
  if [ "$status" != "running" ]; then
    grove_die "Task $task_id is not running (status: $status)."
  fi

  local title
  title=$(grove_db_task_get "$task_id" "title")
  _grove_detach_task "$task_id" "$title"
}

# Internal: detach a single task and print info
_grove_detach_task() {
  local tid="$1"
  local title="$2"

  # Find log file
  local log_file=""
  local esc_id
  esc_id=$(grove_db_escape "$tid")
  log_file=$(grove_db_get "SELECT output_log FROM sessions WHERE task_id = '$esc_id' AND status = 'running' ORDER BY started_at DESC LIMIT 1;")

  if [ -z "$log_file" ] || [ ! -f "$log_file" ]; then
    # Try log dir glob
    for f in "$GROVE_LOG_DIR/${tid}"-*.log; do
      if [ -f "$f" ]; then
        log_file="$f"
      fi
    done
  fi

  # Log event
  grove_db_event "$tid" "detached" "Worker detached from terminal"

  printf '%sWorker %s continues in background.%s\n' "$GREEN" "$tid" "$RESET"
  printf '  %sTask:%s  %s\n' "$DIM" "$RESET" "$(grove_truncate "${title:-$tid}" 60)"
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    printf '  %sLog:%s   %s\n' "$DIM" "$RESET" "$log_file"
  fi
  printf '  %sWatch:%s grove watch %s\n' "$DIM" "$RESET" "$tid"
}

grove_help_detach() {
  printf 'Usage: grove detach [TASK_ID] [--all]\n\n'
  printf 'Detach from a running worker. The worker continues\n'
  printf 'running in the background, logging to its output file.\n\n'
  printf 'Options:\n'
  printf '  --all, -a    Detach all running tasks\n\n'
  printf 'If no TASK_ID is given and only one task is running,\n'
  printf 'that task is detached. If multiple tasks are running,\n'
  printf 'you must specify a task ID or use --all.\n\n'
  printf 'Examples:\n'
  printf '  grove detach           Detach the current worker\n'
  printf '  grove detach W-001     Detach task W-001\n'
  printf '  grove detach --all     Detach all running workers\n\n'
  printf 'Resume watching with: grove watch TASK_ID\n'
}
