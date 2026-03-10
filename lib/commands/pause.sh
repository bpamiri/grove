#!/usr/bin/env bash
# lib/commands/pause.sh — grove pause
# Signal a running worker to save state and stop.

grove_cmd_pause() {
  grove_require_db

  local task_id=""
  local pause_all=0

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --all|-a)
        pause_all=1
        shift
        ;;
      -h|--help)
        grove_help_pause
        return 0
        ;;
      *)
        if [ -z "$task_id" ]; then
          task_id="$1"
        else
          grove_warn "Unexpected argument: $1"
        fi
        shift
        ;;
    esac
  done

  # Handle --all: pause every running task
  if [ "$pause_all" -eq 1 ]; then
    local running_tasks
    running_tasks=$(grove_db_tasks_by_status "running")
    if [ -z "$running_tasks" ]; then
      grove_info "No running tasks to pause."
      return 0
    fi

    local count=0
    local old_ifs="$IFS"
    while IFS='	' read -r tid trepo ttitle; do
      [ -z "$tid" ] && continue
      _grove_pause_task "$tid"
      count=$(( count + 1 ))
    done <<EOF
$running_tasks
EOF
    IFS="$old_ifs"

    grove_success "Paused $count task(s)."
    return 0
  fi

  # Single task mode
  if [ -z "$task_id" ]; then
    grove_die "Usage: grove pause TASK_ID  (or grove pause --all)"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Verify task is running
  local status
  status=$(grove_db_task_status "$task_id")
  if [ "$status" != "running" ]; then
    grove_die "Task $task_id is '$status', not 'running'. Only running tasks can be paused."
  fi

  _grove_pause_task "$task_id"
}

# Internal: pause a single task by ID (assumes it exists and is running)
_grove_pause_task() {
  local task_id="$1"
  local title
  title=$(grove_db_task_get "$task_id" "title")

  grove_info "Pausing $task_id: $title"

  # Find the active session and its worker PID
  local session_id
  session_id=$(grove_db_get "SELECT id FROM sessions WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running' ORDER BY id DESC LIMIT 1;")
  local worker_pid=""
  if [ -n "$session_id" ]; then
    worker_pid=$(grove_db_get "SELECT pid FROM sessions WHERE id = $session_id;")
  fi

  # Signal the worker to stop
  if [ -n "$worker_pid" ] && grove_monitor_is_alive "$worker_pid"; then
    grove_debug "Sending SIGTERM to worker PID $worker_pid"
    kill "$worker_pid" 2>/dev/null || true

    # Wait briefly for graceful shutdown (up to 5 seconds)
    local wait_count=0
    while grove_monitor_is_alive "$worker_pid" && [ "$wait_count" -lt 10 ]; do
      sleep 0.5
      wait_count=$(( wait_count + 1 ))
    done

    # Force kill if still alive
    if grove_monitor_is_alive "$worker_pid"; then
      grove_debug "Worker still alive, sending SIGKILL"
      kill -9 "$worker_pid" 2>/dev/null || true
    fi
  fi

  # Read session summary from worktree if it exists
  local worktree_path
  worktree_path=$(grove_db_task_get "$task_id" "worktree_path")
  local session_summary=""
  if [ -n "$worktree_path" ] && [ -f "$worktree_path/.grove/session-summary.md" ]; then
    session_summary=$(cat "$worktree_path/.grove/session-summary.md")
    grove_debug "Read session summary from $worktree_path/.grove/session-summary.md"
  fi

  # Get files modified via git diff in worktree
  local files_modified=""
  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    files_modified=$(cd "$worktree_path" && git diff --name-only HEAD 2>/dev/null || echo "")
    if [ -z "$files_modified" ]; then
      files_modified=$(cd "$worktree_path" && git diff --name-only 2>/dev/null || echo "")
    fi
    # Include untracked files
    local untracked
    untracked=$(cd "$worktree_path" && git ls-files --others --exclude-standard 2>/dev/null || echo "")
    if [ -n "$untracked" ]; then
      if [ -n "$files_modified" ]; then
        files_modified="$files_modified
$untracked"
      else
        files_modified="$untracked"
      fi
    fi
  fi

  # Parse cost from the session log if available
  local log_file=""
  if [ -n "$session_id" ]; then
    log_file=$(grove_db_get "SELECT output_log FROM sessions WHERE id = $session_id;")
  fi
  local cost_usd="0"
  local total_tokens="0"
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    local cost_data
    cost_data=$(grove_monitor_parse_cost "$log_file")
    cost_usd=$(printf '%s' "$cost_data" | cut -f1)
    local input_tokens
    input_tokens=$(printf '%s' "$cost_data" | cut -f2)
    local output_tokens
    output_tokens=$(printf '%s' "$cost_data" | cut -f3)
    total_tokens=$(( input_tokens + output_tokens ))
  fi

  # Update task: status, session_summary, files_modified, paused_at
  grove_db_task_set_status "$task_id" "paused"
  grove_db_task_set "$task_id" "paused_at" "$(grove_timestamp)"
  if [ -n "$session_summary" ]; then
    grove_db_task_set "$task_id" "session_summary" "$session_summary"
  fi
  if [ -n "$files_modified" ]; then
    grove_db_task_set "$task_id" "files_modified" "$files_modified"
  fi

  # Update task cost
  if [ "$cost_usd" != "0" ]; then
    grove_db_exec "UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + ${cost_usd}, tokens_used = COALESCE(tokens_used, 0) + ${total_tokens}, updated_at = datetime('now') WHERE id = '$(grove_db_escape "$task_id")';"
  fi

  # End the session
  if [ -n "$session_id" ]; then
    grove_db_exec "UPDATE sessions SET ended_at = datetime('now'), status = 'paused', cost_usd = ${cost_usd:-0}, tokens_used = ${total_tokens:-0} WHERE id = $session_id;"
    if [ -n "$session_summary" ]; then
      grove_db_exec "UPDATE sessions SET summary = '$(grove_db_escape "$session_summary")' WHERE id = $session_id;"
    fi
  fi

  # Log paused event
  grove_db_event "$task_id" "paused" "Task paused (session $session_id, cost: \$${cost_usd:-0})"

  grove_success "Paused $task_id"
  if [ -n "$files_modified" ]; then
    local file_count
    file_count=$(printf '%s\n' "$files_modified" | wc -l | tr -d ' ')
    printf '  %sFiles modified:%s %s\n' "$DIM" "$RESET" "$file_count"
  fi
  if [ -n "$session_summary" ]; then
    printf '  %sSession summary:%s saved\n' "$DIM" "$RESET"
  fi
}

grove_help_pause() {
  printf 'Usage: grove pause TASK_ID\n'
  printf '       grove pause --all\n\n'
  printf 'Pause a running task. The worker process is stopped and the\n'
  printf 'current state is saved for later resumption with "grove resume".\n\n'
  printf 'Grove captures:\n'
  printf '  - Session summary (from .grove/session-summary.md if written)\n'
  printf '  - Modified files (via git diff)\n'
  printf '  - Cost and token usage from the session log\n\n'
  printf 'Options:\n'
  printf '  --all, -a    Pause all currently running tasks\n\n'
  printf 'Examples:\n'
  printf '  grove pause W-005      Pause a specific task\n'
  printf '  grove pause --all      Pause all running tasks\n'
}
