#!/usr/bin/env bash
# lib/commands/done.sh — grove done
# Mark a task complete after PR merge.

grove_cmd_done() {
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
        grove_help_done
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
    grove_die "Usage: grove done TASK_ID"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Check status
  local current_status
  current_status=$(grove_db_task_status "$task_id")

  case "$current_status" in
    done|review)
      ;;
    completed)
      grove_info "Task $task_id is already completed."
      return 0
      ;;
    *)
      grove_error "Cannot complete task $task_id — status is '$current_status'."
      grove_info "Task must be in 'done' or 'review' status. Current: $current_status"
      return 1
      ;;
  esac

  # Check PR merge status if task has a PR
  local pr_url
  pr_url=$(grove_db_task_get "$task_id" "pr_url")

  if [ -n "$pr_url" ]; then
    grove_require gh

    local pr_number
    pr_number=$(grove_db_task_get "$task_id" "pr_number")
    local repo
    repo=$(grove_db_task_get "$task_id" "repo")
    local github_full
    github_full=$(grove_db_get "SELECT github_full FROM repos WHERE name = '$(grove_db_escape "$repo")';")

    if [ -n "$github_full" ] && [ -n "$pr_number" ]; then
      local merged
      merged=$(gh pr view "$pr_number" --repo "$github_full" --json merged 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.loads(sys.stdin.read())
    print('true' if data.get('merged', False) else 'false')
except:
    print('unknown')
" 2>/dev/null)

      if [ "$merged" = "false" ]; then
        if [ "$force" -eq 1 ]; then
          grove_warn "PR #$pr_number is not merged. Completing anyway (--force)."
        else
          grove_error "PR #$pr_number is not yet merged."
          grove_info "Merge the PR first, or use --force to override."
          return 1
        fi
      elif [ "$merged" = "true" ]; then
        grove_debug "PR #$pr_number is merged."
      else
        grove_warn "Could not determine PR merge status. Continuing."
      fi
    fi
  fi

  # Set completed
  local now
  now=$(grove_timestamp)
  grove_db_task_set_status "$task_id" "completed"
  grove_db_task_set "$task_id" "completed_at" "$now"
  grove_db_event "$task_id" "completed" "Task marked completed"

  # Clean up worktree if it exists
  local worktree_path
  worktree_path=$(grove_db_task_get "$task_id" "worktree_path")

  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
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
      fi
    fi
  fi

  # Summary
  local title
  title=$(grove_db_task_get "$task_id" "title")
  local cost_usd
  cost_usd=$(grove_db_task_get "$task_id" "cost_usd")
  local created_at
  created_at=$(grove_db_task_get "$task_id" "created_at")
  local repo_name
  repo_name=$(grove_db_task_get "$task_id" "repo")

  printf '\n'
  grove_success "Task $task_id completed!"
  printf '\n'
  printf '  %sTitle:%s    %s\n' "$BOLD" "$RESET" "$title"
  printf '  %sRepo:%s     %s\n' "$BOLD" "$RESET" "$repo_name"

  if [ -n "$pr_url" ]; then
    printf '  %sPR:%s       %s\n' "$BOLD" "$RESET" "$pr_url"
  fi

  if [ -n "$cost_usd" ] && [ "$cost_usd" != "0" ] && [ "$cost_usd" != "0.0" ]; then
    printf '  %sCost:%s     %s\n' "$BOLD" "$RESET" "$(grove_dollars "$cost_usd")"
  fi

  if [ -n "$created_at" ]; then
    local elapsed
    elapsed=$(grove_relative_time "$created_at" 2>/dev/null || echo "$created_at")
    printf '  %sStarted:%s  %s\n' "$BOLD" "$RESET" "$elapsed"
  fi

  printf '\n'
}

grove_help_done() {
  printf 'Usage: grove done TASK_ID [OPTIONS]\n\n'
  printf 'Mark a task as completed after PR merge.\n\n'
  printf 'Verifies the task is in "done" or "review" status and\n'
  printf 'checks that the linked PR (if any) has been merged.\n\n'
  printf 'Options:\n'
  printf '  --force, -f     Complete even if PR is not merged\n\n'
  printf 'Actions:\n'
  printf '  - Sets status to "completed"\n'
  printf '  - Sets completed_at timestamp\n'
  printf '  - Removes worktree if present\n'
  printf '  - Logs "completed" event\n\n'
  printf 'Examples:\n'
  printf '  grove done W-001           Complete task after PR merge\n'
  printf '  grove done W-001 --force   Complete without merge check\n'
}
