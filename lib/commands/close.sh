#!/usr/bin/env bash
# lib/commands/close.sh — grove close
# Close/abandon a task without completing it.

grove_cmd_close() {
  grove_require_db

  local task_id=""
  local cleanup=0
  local force=0

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --cleanup)
        cleanup=1
        shift
        ;;
      --force|-f)
        force=1
        shift
        ;;
      -h|--help)
        grove_help_close
        return 0
        ;;
      -*)
        grove_warn "Unknown option: $1"
        shift
        ;;
      *)
        if [ -z "$task_id" ]; then
          task_id="$1"
        fi
        shift
        ;;
    esac
  done

  if [ -z "$task_id" ]; then
    grove_die "Usage: grove close TASK_ID"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  local current_status
  current_status=$(grove_db_task_status "$task_id")

  # Already closed
  case "$current_status" in
    failed)
      grove_info "Task $task_id is already closed (failed)."
      return 0
      ;;
    completed)
      grove_info "Task $task_id is already completed. Use 'grove done' for completed tasks."
      return 0
      ;;
  esac

  local title
  title=$(grove_db_task_get "$task_id" "title")

  # Confirm unless --force
  if [ "$force" -eq 0 ]; then
    if ! grove_confirm "Close $task_id? This marks it as abandoned."; then
      grove_info "Cancelled."
      return 0
    fi
  fi

  # If running, kill worker first
  if [ "$current_status" = "running" ]; then
    local session_pid
    session_pid=$(grove_db_get "SELECT pid FROM sessions WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running' ORDER BY started_at DESC LIMIT 1;")
    if [ -n "$session_pid" ] && [ "$session_pid" != "" ]; then
      grove_info "Stopping running worker (PID $session_pid)..."
      kill "$session_pid" 2>/dev/null || true
      # End the session
      local session_id
      session_id=$(grove_db_get "SELECT id FROM sessions WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running' ORDER BY started_at DESC LIMIT 1;")
      if [ -n "$session_id" ]; then
        grove_db_session_end "$session_id" "cancelled"
      fi
    fi
  fi

  # Set status to failed
  grove_db_task_set_status "$task_id" "failed"
  grove_db_event "$task_id" "cancelled" "Task closed/abandoned"

  # Handle worktree cleanup
  local worktree_path
  worktree_path=$(grove_db_task_get "$task_id" "worktree_path")

  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    local do_cleanup="$cleanup"
    if [ "$do_cleanup" -eq 0 ] && [ "$force" -eq 0 ]; then
      if grove_confirm "Remove worktree at $worktree_path?"; then
        do_cleanup=1
      fi
    fi

    if [ "$do_cleanup" -eq 1 ]; then
      local repo_name
      repo_name=$(grove_db_task_get "$task_id" "repo")
      local local_path
      local_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")

      if [ -n "$local_path" ]; then
        local expanded_path
        expanded_path="$local_path"
        case "$expanded_path" in "~/"*) expanded_path="$HOME/${expanded_path#\~/}" ;; "~") expanded_path="$HOME" ;; esac
        if [ -d "$expanded_path" ]; then
          grove_debug "Removing worktree: $worktree_path"
          git -C "$expanded_path" worktree remove "$worktree_path" --force 2>/dev/null || true
          grove_db_task_set "$task_id" "worktree_path" ""
          grove_success "Worktree removed."
        fi
      fi
    fi
  fi

  # Handle PR — offer to close it
  local pr_url
  pr_url=$(grove_db_task_get "$task_id" "pr_url")

  if [ -n "$pr_url" ]; then
    local pr_number
    pr_number=$(grove_db_task_get "$task_id" "pr_number")
    local repo_name
    repo_name=$(grove_db_task_get "$task_id" "repo")
    local github_full
    github_full=$(grove_db_get "SELECT github_full FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")

    if [ -n "$github_full" ] && [ -n "$pr_number" ]; then
      local close_pr=0
      if [ "$force" -eq 1 ] || [ "$cleanup" -eq 1 ]; then
        close_pr=1
      elif grove_confirm "Close PR #$pr_number on GitHub?"; then
        close_pr=1
      fi

      if [ "$close_pr" -eq 1 ]; then
        grove_require gh
        if gh pr close "$pr_number" --repo "$github_full" 2>/dev/null; then
          grove_success "PR #$pr_number closed."
          grove_db_event "$task_id" "pr_closed" "PR #$pr_number closed on GitHub"
        else
          grove_warn "Could not close PR #$pr_number."
        fi
      fi
    fi
  fi

  printf '\n'
  grove_success "Task $task_id closed."
  printf '  %sTitle:%s  %s\n' "$BOLD" "$RESET" "$title"
  printf '  %sStatus:%s %s\n' "$BOLD" "$RESET" "$(grove_badge "failed" "red")"
  printf '\n'
}

grove_help_close() {
  printf 'Usage: grove close TASK_ID [OPTIONS]\n\n'
  printf 'Close/abandon a task without completing it.\n\n'
  printf 'Sets the task status to "failed" and optionally cleans up\n'
  printf 'the worktree and closes the associated PR.\n\n'
  printf 'Options:\n'
  printf '  --cleanup       Remove worktree without asking\n'
  printf '  --force, -f     Skip confirmation prompts\n\n'
  printf 'Actions:\n'
  printf '  - Kills running worker (if task is running)\n'
  printf '  - Sets status to "failed"\n'
  printf '  - Optionally removes worktree\n'
  printf '  - Optionally closes PR on GitHub\n'
  printf '  - Logs "cancelled" event\n\n'
  printf 'Examples:\n'
  printf '  grove close W-001              Interactive close\n'
  printf '  grove close W-001 --cleanup    Close and remove worktree\n'
  printf '  grove close W-001 --force      Close without prompts\n'
}
