#!/usr/bin/env bash
# lib/commands/work.sh — grove work / grove run
# The core dispatch engine: selects a task, creates a worktree, spawns a Claude worker.


# ---------------------------------------------------------------------------
# Internal: parse stream-json output for cost and token info
# ---------------------------------------------------------------------------
_grove_work_parse_costs() {
  local log_file="$1"
  python3 -c "
import json, sys

log_file = sys.argv[1]
total_cost = 0.0
total_input = 0
total_output = 0

try:
    with open(log_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue

            # Look for result messages with usage/cost info
            if isinstance(obj, dict):
                # stream-json cost_usd field
                if 'cost_usd' in obj:
                    try:
                        total_cost = float(obj['cost_usd'])
                    except (ValueError, TypeError):
                        pass

                # Usage info
                usage = obj.get('usage', {})
                if isinstance(usage, dict):
                    total_input += int(usage.get('input_tokens', 0))
                    total_output += int(usage.get('output_tokens', 0))

                # result type with session cost
                if obj.get('type') == 'result':
                    if 'cost_usd' in obj:
                        try:
                            total_cost = float(obj['cost_usd'])
                        except (ValueError, TypeError):
                            pass
                    result_usage = obj.get('usage', {})
                    if isinstance(result_usage, dict):
                        total_input = int(result_usage.get('input_tokens', total_input))
                        total_output = int(result_usage.get('output_tokens', total_output))

except Exception:
    pass

total_tokens = total_input + total_output
print(f'{total_cost}\t{total_tokens}')
" "$log_file"
}

# ---------------------------------------------------------------------------
# Internal: read session summary from worktree
# ---------------------------------------------------------------------------
_grove_work_read_summary() {
  local worktree_path="$1"
  local summary_file="$worktree_path/.grove/session-summary.md"
  if [ -f "$summary_file" ]; then
    cat "$summary_file"
  fi
}

# ---------------------------------------------------------------------------
# Internal: get files modified in worktree (via git diff)
# ---------------------------------------------------------------------------
_grove_work_files_modified() {
  local worktree_path="$1"
  if [ -d "$worktree_path" ]; then
    git -C "$worktree_path" diff --name-only HEAD 2>/dev/null || true
    git -C "$worktree_path" diff --name-only --cached 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Internal: dispatch a single task
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_grove_work_dispatch() {
  local task_id="$1"
  local interactive="${2:-1}"  # 1 = show output, 0 = background

  local repo title status estimated_cost
  repo=$(grove_db_task_get "$task_id" "repo")
  title=$(grove_db_task_get "$task_id" "title")
  status=$(grove_db_task_status "$task_id")
  estimated_cost=$(grove_db_task_get "$task_id" "estimated_cost")

  # -- Pre-flight: status check --
  case "$status" in
    ready)
      ;;
    planned)
      grove_info "Task $task_id is planned but not explicitly marked ready. Auto-approving."
      grove_db_task_set_status "$task_id" "ready"
      ;;
    paused)
      grove_info "Task $task_id is paused. Use 'grove resume $task_id' for resume-specific prompting."
      grove_info "Continuing with standard dispatch..."
      ;;
    running)
      grove_warn "Task $task_id is already running."
      return 1
      ;;
    done|completed)
      grove_warn "Task $task_id is already done."
      return 1
      ;;
    *)
      grove_die "Task $task_id has status '$status' — must be 'ready' or 'planned' to start."
      ;;
  esac

  # -- Pre-flight: budget check --
  local check_amount="${estimated_cost:-0}"
  if [ "$check_amount" = "" ]; then
    check_amount="0"
  fi
  if ! grove_db_budget_check "$check_amount"; then
    local week_cost week_budget
    week_cost=$(grove_db_cost_week)
    week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")
    grove_error "Budget exceeded. Weekly spend: $(grove_dollars "$week_cost") / $(grove_dollars "$week_budget")"
    if [ "$interactive" = "1" ]; then
      if ! grove_confirm "Override budget and continue?"; then
        return 1
      fi
    else
      grove_error "Skipping $task_id (budget exceeded, non-interactive mode)."
      return 1
    fi
  fi

  # -- Pre-flight: claude command --
  if ! command -v claude >/dev/null 2>&1; then
    grove_die "Required command not found: claude"
  fi

  # -- Create worktree --
  grove_info "Creating worktree for $task_id ($repo)..."
  local worktree_path
  worktree_path=$(grove_worktree_create "$task_id" "$repo")
  if [ -z "$worktree_path" ] || [ ! -d "$worktree_path" ]; then
    grove_die "Failed to create worktree for $task_id."
  fi
  grove_debug "Worktree: $worktree_path"

  # -- Generate prompt --
  local prompt
  if [ "$status" = "paused" ]; then
    prompt=$(grove_prompt_resume "$task_id")
  else
    prompt=$(grove_prompt_build "$task_id")
  fi

  # -- Create session --
  local session_id
  session_id=$(grove_db_session_create "$task_id")
  grove_db_task_set "$task_id" "session_id" "$session_id"

  # -- Update task status --
  grove_db_task_set_status "$task_id" "running"
  grove_db_task_set "$task_id" "started_at" "$(grove_timestamp)"

  # -- Log file --
  local ts_slug
  ts_slug=$(date +%Y%m%d-%H%M%S)
  local log_file="$GROVE_LOG_DIR/${task_id}-${ts_slug}.log"

  # -- Log event --
  grove_db_event "$task_id" "worker_spawned" "Worker session $session_id started" "Log: $log_file"

  # -- Update session with log path --
  grove_db_exec "UPDATE sessions SET output_log = '$(grove_db_escape "$log_file")' WHERE id = $session_id;"

  # -- Spawn Claude --
  local branch
  branch=$(grove_db_task_get "$task_id" "branch")
  grove_info "Dispatching worker for $task_id: $title"
  printf '  %sBranch:%s  %s\n' "$DIM" "$RESET" "$branch"
  printf '  %sWorktree:%s %s\n' "$DIM" "$RESET" "$worktree_path"
  printf '  %sLog:%s     %s\n' "$DIM" "$RESET" "$log_file"
  printf '  %sSession:%s %s\n' "$DIM" "$RESET" "$session_id"
  printf '\n'

  local exit_code=0
  if [ "$interactive" = "1" ]; then
    # Foreground: stream output. Use process substitution to capture claude's exit code
    (cd "$worktree_path" && claude -p "$prompt" --output-format stream-json 2>&1; echo $? > "$log_file.exitcode") | tee "$log_file" || true
    if [ -f "$log_file.exitcode" ]; then
      exit_code=$(cat "$log_file.exitcode")
      rm -f "$log_file.exitcode"
    fi
  else
    # Background: redirect to log only
    (cd "$worktree_path" && claude -p "$prompt" --output-format stream-json > "$log_file" 2>&1) &
    local worker_pid=$!
    grove_db_exec "UPDATE sessions SET pid = $worker_pid WHERE id = $session_id;"
    grove_success "Worker $task_id running in background (PID $worker_pid)"
    grove_info "Follow with: tail -f $log_file"
    return 0
  fi

  # -- Post-completion (foreground only) --
  printf '\n'
  grove_info "Worker finished for $task_id (exit code: $exit_code)"

  # Read session summary from worktree
  local summary
  summary=$(_grove_work_read_summary "$worktree_path")
  if [ -n "$summary" ]; then
    local esc_summary
    esc_summary=$(grove_db_escape "$summary")
    grove_db_task_set "$task_id" "session_summary" "$esc_summary"
    grove_db_exec "UPDATE sessions SET summary = '$(grove_db_escape "$summary")' WHERE id = $session_id;"
    grove_debug "Session summary captured"
  fi

  # Get files modified
  local files
  files=$(_grove_work_files_modified "$worktree_path")
  if [ -n "$files" ]; then
    # Deduplicate and store
    local unique_files
    unique_files=$(printf '%s' "$files" | sort -u | tr '\n' ', ' | sed 's/,$//')
    grove_db_task_set "$task_id" "files_modified" "$unique_files"
    grove_debug "Files modified: $unique_files"
  fi

  # Parse cost/token info from log
  local cost_tokens
  cost_tokens=$(_grove_work_parse_costs "$log_file")
  if [ -n "$cost_tokens" ]; then
    local cost_usd tokens_used
    cost_usd=$(printf '%s' "$cost_tokens" | cut -f1)
    tokens_used=$(printf '%s' "$cost_tokens" | cut -f2)
    if [ -n "$cost_usd" ] && [ "$cost_usd" != "0" ] && [ "$cost_usd" != "0.0" ]; then
      grove_db_exec "UPDATE tasks SET cost_usd = $cost_usd WHERE id = '$(grove_db_escape "$task_id")';"
      grove_db_exec "UPDATE sessions SET cost_usd = $cost_usd WHERE id = $session_id;"
      grove_debug "Cost: \$$cost_usd"
    fi
    if [ -n "$tokens_used" ] && [ "$tokens_used" != "0" ]; then
      grove_db_exec "UPDATE tasks SET tokens_used = $tokens_used WHERE id = '$(grove_db_escape "$task_id")';"
      grove_db_exec "UPDATE sessions SET tokens_used = $tokens_used WHERE id = $session_id;"
      grove_debug "Tokens: $tokens_used"
    fi
  fi

  # Set final status
  if [ "$exit_code" -eq 0 ]; then
    grove_db_task_set_status "$task_id" "done"
    grove_db_session_end "$session_id" "completed"
    grove_success "Task $task_id completed."
  else
    grove_db_task_set_status "$task_id" "failed"
    grove_db_session_end "$session_id" "failed"
    grove_error "Task $task_id failed (exit $exit_code)."
  fi

  grove_db_event "$task_id" "worker_ended" "Session $session_id ended (exit $exit_code)"

  return "$exit_code"
}

# ---------------------------------------------------------------------------
# grove_cmd_work [TASK_ID] [--repo NAME]
# Main entry point for dispatching work.
# ---------------------------------------------------------------------------
grove_cmd_work() {
  grove_require_db
  grove_require_config

  local task_id=""
  local repo_filter=""
  local is_run=0

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove work --repo NAME"
        fi
        repo_filter="$2"
        shift 2
        ;;
      --repo=*)
        repo_filter="${1#--repo=}"
        shift
        ;;
      --run)
        is_run=1
        shift
        ;;
      -h|--help)
        grove_help_work
        return 0
        ;;
      -*)
        grove_die "Unknown option: $1"
        ;;
      *)
        task_id="$1"
        shift
        ;;
    esac
  done

  # --- Mode 1: Specific task ID ---
  if [ -n "$task_id" ]; then
    # Verify task exists
    if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
      grove_die "Task not found: $task_id"
    fi
    _grove_work_dispatch "$task_id" "1"
    return $?
  fi

  # --- Mode 2: Next ready task for a repo ---
  if [ -n "$repo_filter" ]; then
    local esc_repo
    esc_repo=$(grove_db_escape "$repo_filter")
    local next_row
    next_row=$(grove_db_query "SELECT id, title FROM tasks WHERE repo = '$esc_repo' AND status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 1;")
    if [ -z "$next_row" ]; then
      grove_info "No ready tasks for repo: $repo_filter"
      return 0
    fi
    local next_id next_title
    next_id=$(printf '%s' "$next_row" | cut -f1)
    next_title=$(printf '%s' "$next_row" | cut -f2)
    grove_info "Next task for $repo_filter: $next_id — $next_title"
    if [ "$is_run" = "1" ] || grove_confirm "Start this task?"; then
      _grove_work_dispatch "$next_id" "1"
      return $?
    fi
    return 0
  fi

  # --- Mode 3: Batch selection (no args) ---
  local ready_rows
  ready_rows=$(grove_db_query "SELECT id, repo, title, estimated_cost FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 20;")

  if [ -z "$ready_rows" ]; then
    grove_info "No tasks ready to work on."
    printf '  Run %sgrove add%s to create a task, or %sgrove sync%s to pull from GitHub.\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
    return 0
  fi

  # Non-interactive (run mode): pick the first task
  if [ "$is_run" = "1" ]; then
    local first_id
    first_id=$(printf '%s' "$ready_rows" | head -1 | cut -f1)
    _grove_work_dispatch "$first_id" "0"
    return $?
  fi

  # Interactive: show tasks and let user pick
  grove_header "Ready Tasks"

  local max_concurrent
  max_concurrent=$(grove_config_get "settings.max_concurrent" 2>/dev/null || echo "4")
  local week_cost week_budget
  week_cost=$(grove_db_cost_week)
  week_budget=$(grove_budget_get "per_week" 2>/dev/null || echo "100.00")

  printf '  %sBudget:%s %s / %s this week\n' "$DIM" "$RESET" "$(grove_dollars "$week_cost")" "$(grove_dollars "$week_budget")"
  printf '  %sMax concurrent:%s %s\n\n' "$DIM" "$RESET" "$max_concurrent"

  # Build task list
  local task_ids=""
  local i=1
  local old_ifs="$IFS"
  while IFS='	' read -r tid trepo ttitle tcost; do
    [ -z "$tid" ] && continue
    local cost_str=""
    if [ -n "$tcost" ] && [ "$tcost" != "0" ]; then
      cost_str=" ~$(grove_dollars "$tcost")"
    fi
    printf '  %s[%d]%s %s%s%s %s%s%s  %s%s%s%s\n' \
      "$BOLD" "$i" "$RESET" \
      "$DIM" "$tid" "$RESET" \
      "$DIM" "$trepo" "$RESET" \
      "$(grove_truncate "$ttitle" 40)" \
      "$DIM" "$cost_str" "$RESET"
    task_ids="$task_ids $tid"
    i=$(( i + 1 ))
  done <<EOF
$ready_rows
EOF
  IFS="$old_ifs"
  local task_count=$(( i - 1 ))

  if [ "$task_count" -eq 0 ]; then
    grove_info "No tasks to display."
    return 0
  fi

  printf '\n'
  printf '  Enter task number(s) separated by spaces, or "q" to quit.\n'
  printf '  Example: 1 3 5  (dispatches tasks 1, 3, and 5)\n\n'
  printf '  Selection: '
  read -r selection

  if [ -z "$selection" ] || [ "$selection" = "q" ] || [ "$selection" = "Q" ]; then
    return 0
  fi

  # Convert task_ids to an array-like structure (space-separated, 1-indexed)
  # task_ids has a leading space, so " T-001 T-002 ..."
  local selected_tasks=""
  local sel
  for sel in $selection; do
    # Validate numeric
    if ! printf '%s' "$sel" | grep -q '^[0-9][0-9]*$'; then
      grove_warn "Ignoring non-numeric selection: $sel"
      continue
    fi
    if [ "$sel" -lt 1 ] 2>/dev/null || [ "$sel" -gt "$task_count" ] 2>/dev/null; then
      grove_warn "Ignoring out-of-range selection: $sel"
      continue
    fi
    # Get the task ID at position $sel
    local pick_id
    pick_id=$(printf '%s' "$task_ids" | tr ' ' '\n' | sed -n "${sel}p")
    if [ -n "$pick_id" ]; then
      selected_tasks="$selected_tasks $pick_id"
    fi
  done

  selected_tasks=$(printf '%s' "$selected_tasks" | sed 's/^ //')
  if [ -z "$selected_tasks" ]; then
    grove_info "No tasks selected."
    return 0
  fi

  # Count selected
  local selected_count=0
  local t
  for t in $selected_tasks; do
    selected_count=$(( selected_count + 1 ))
  done

  # Confirm
  grove_info "Selected $selected_count task(s): $selected_tasks"
  if ! grove_confirm "Dispatch these tasks?"; then
    return 0
  fi

  printf '\n'

  # Dispatch
  if [ "$selected_count" -eq 1 ]; then
    # Single task: foreground
    _grove_work_dispatch "$selected_tasks" "1"
    return $?
  else
    # Multiple tasks: first in foreground (so user sees it), rest in background
    local first=1
    local dispatched=0
    for t in $selected_tasks; do
      if [ "$dispatched" -ge "$max_concurrent" ] 2>/dev/null; then
        grove_warn "Reached max concurrent ($max_concurrent). Skipping remaining."
        break
      fi
      if [ "$first" = "1" ]; then
        grove_info "Dispatching $t in foreground..."
        _grove_work_dispatch "$t" "1" || true
        first=0
      else
        grove_info "Dispatching $t in background..."
        _grove_work_dispatch "$t" "0" || true
      fi
      dispatched=$(( dispatched + 1 ))
    done
  fi
}

# ---------------------------------------------------------------------------
# grove_cmd_run — non-interactive alias for grove_cmd_work
# ---------------------------------------------------------------------------
grove_cmd_run() {
  grove_cmd_work --run "$@"
}

# ---------------------------------------------------------------------------
# grove_help_work
# ---------------------------------------------------------------------------
grove_help_work() {
  printf 'Usage: grove work [TASK_ID] [--repo NAME]\n\n'
  printf 'Dispatch a Claude Code worker session for a task.\n\n'
  printf 'Modes:\n'
  printf '  grove work TASK_ID     Start a specific task\n'
  printf '  grove work --repo NAME Pick the next ready task for a repo\n'
  printf '  grove work             Show ready tasks, choose interactively\n'
  printf '  grove run TASK_ID      Non-interactive mode (auto-pick, no prompts)\n\n'
  printf 'What happens:\n'
  printf '  1. Creates a git worktree for the task\n'
  printf '  2. Generates a prompt with task context\n'
  printf '  3. Spawns "claude -p" with stream-json output\n'
  printf '  4. Captures session summary, cost, and files modified\n'
  printf '  5. Updates task status (done/failed)\n\n'
  printf 'Options:\n'
  printf '  --repo NAME    Filter to tasks for a specific repo\n'
  printf '  --run          Non-interactive mode (same as "grove run")\n\n'
  printf 'The task must be in "ready" or "planned" status. Budget is checked\n'
  printf 'against the weekly limit before dispatch. Override with confirmation.\n\n'
  printf 'Batch mode: select multiple tasks to dispatch. The first runs in\n'
  printf 'foreground; the rest run in background up to max_concurrent.\n'
}

grove_help_run() {
  printf 'Usage: grove run [TASK_ID] [--repo NAME]\n\n'
  printf 'Alias for "grove work" in non-interactive mode.\n'
  printf 'Auto-picks tasks and skips confirmation prompts.\n\n'
  printf 'See "grove help work" for full details.\n'
}
