#!/usr/bin/env bash
# lib/commands/cancel.sh — grove cancel
# Stop and clean up a task, removing worktree and discarding changes.

grove_cmd_cancel() {
  grove_require_db

  local task_id=""
  local force=0

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f)
        force=1
        shift
        ;;
      -h|--help)
        grove_help_cancel
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

  if [ -z "$task_id" ]; then
    grove_die "Usage: grove cancel TASK_ID"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  local title
  title=$(grove_db_task_get "$task_id" "title")
  local status
  status=$(grove_db_task_status "$task_id")
  local worktree_path
  worktree_path=$(grove_db_task_get "$task_id" "worktree_path")
  local branch
  branch=$(grove_db_task_get "$task_id" "branch")
  local repo
  repo=$(grove_db_task_get "$task_id" "repo")

  # Don't cancel already completed/failed tasks
  if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
    grove_die "Task $task_id is already '$status'."
  fi

  # Confirm with user unless --force
  if [ "$force" -eq 0 ]; then
    printf '%sCancel %s?%s %s\n' "$BOLD" "$task_id" "$RESET" "$title"
    if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
      printf '  This will remove the worktree and discard all changes.\n'
    fi
    if ! grove_confirm "Proceed?" "n"; then
      grove_info "Cancelled."
      return 0
    fi
  fi

  grove_info "Cancelling $task_id: $title"

  # If task is running, kill the worker process
  if [ "$status" = "running" ]; then
    local session_id
    session_id=$(grove_db_get "SELECT id FROM sessions WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running' ORDER BY id DESC LIMIT 1;")
    local worker_pid=""
    if [ -n "$session_id" ]; then
      worker_pid=$(grove_db_get "SELECT pid FROM sessions WHERE id = $session_id;")
    fi

    if [ -n "$worker_pid" ] && grove_monitor_is_alive "$worker_pid"; then
      grove_debug "Killing worker PID $worker_pid"
      kill "$worker_pid" 2>/dev/null || true
      # Brief wait then force kill
      local wait_count=0
      while grove_monitor_is_alive "$worker_pid" && [ "$wait_count" -lt 6 ]; do
        sleep 0.5
        wait_count=$(( wait_count + 1 ))
      done
      if grove_monitor_is_alive "$worker_pid"; then
        kill -9 "$worker_pid" 2>/dev/null || true
      fi
      grove_debug "Worker process stopped"
    fi

    # End the active session
    if [ -n "$session_id" ]; then
      grove_db_session_end "$session_id" "cancelled"
    fi
  fi

  # End any other active sessions for this task
  grove_db_exec "UPDATE sessions SET ended_at = datetime('now'), status = 'cancelled' WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running';"

  # Clean up worktree
  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    grove_debug "Removing worktree at $worktree_path"

    # Get repo local path for git worktree remove
    local repo_path=""
    local repo_detail
    repo_detail=$(grove_config_repo_detail 2>/dev/null || echo "")
    if [ -n "$repo_detail" ]; then
      local old_ifs="$IFS"
      while IFS='	' read -r rname rorg rgithub rpath; do
        if [ "$rname" = "$repo" ]; then
          repo_path="$rpath"
          break
        fi
      done <<EOF
$repo_detail
EOF
      IFS="$old_ifs"
    fi

    # Expand ~ in repo_path
    case "$repo_path" in
      "~/"*) repo_path="$HOME/${repo_path#\~/}" ;;
      "~")   repo_path="$HOME" ;;
    esac

    # Try git worktree remove first, fall back to rm
    local removed=0
    if [ -n "$repo_path" ] && [ -d "$repo_path" ]; then
      if (cd "$repo_path" && git worktree remove "$worktree_path" --force 2>/dev/null); then
        removed=1
      fi
    fi
    if [ "$removed" -eq 0 ]; then
      rm -rf "$worktree_path" 2>/dev/null || true
      # Clean up git worktree bookkeeping if possible
      if [ -n "$repo_path" ] && [ -d "$repo_path" ]; then
        (cd "$repo_path" && git worktree prune 2>/dev/null) || true
      fi
    fi

    # Optionally delete the branch
    if [ -n "$branch" ] && [ -n "$repo_path" ] && [ -d "$repo_path" ]; then
      (cd "$repo_path" && git branch -D "$branch" 2>/dev/null) || true
      grove_debug "Deleted branch $branch"
    fi

    grove_success "Worktree removed"
  fi

  # Set status to failed with cancel event
  grove_db_task_set_status "$task_id" "failed"
  grove_db_task_set "$task_id" "worktree_path" ""
  grove_db_event "$task_id" "cancelled" "Task cancelled by user"

  grove_success "Cancelled $task_id"
}

grove_help_cancel() {
  printf 'Usage: grove cancel TASK_ID [--force]\n\n'
  printf 'Stop and clean up a task. If the task is running, the worker\n'
  printf 'process is killed. The worktree is removed and changes discarded.\n\n'
  printf 'The task status is set to "failed" with a "cancelled" event.\n\n'
  printf 'Options:\n'
  printf '  --force, -f    Skip confirmation prompt\n\n'
  printf 'Examples:\n'
  printf '  grove cancel W-005           Cancel with confirmation\n'
  printf '  grove cancel W-005 --force   Cancel without asking\n'
}
