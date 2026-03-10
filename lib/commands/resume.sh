#!/usr/bin/env bash
# lib/commands/resume.sh — grove resume
# Resume a paused task with full context injection.

grove_cmd_resume() {
  grove_require_db
  grove_require_config

  local task_id=""

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help)
        grove_help_resume
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
    grove_die "Usage: grove resume TASK_ID"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Verify task is paused
  local status
  status=$(grove_db_task_status "$task_id")
  if [ "$status" != "paused" ]; then
    grove_die "Task $task_id is '$status', not 'paused'. Only paused tasks can be resumed."
  fi

  # Read task data from DB
  local title
  title=$(grove_db_task_get "$task_id" "title")
  local repo
  repo=$(grove_db_task_get "$task_id" "repo")
  local session_summary
  session_summary=$(grove_db_task_get "$task_id" "session_summary")
  local files_modified
  files_modified=$(grove_db_task_get "$task_id" "files_modified")
  local next_steps
  next_steps=$(grove_db_task_get "$task_id" "next_steps")
  local worktree_path
  worktree_path=$(grove_db_task_get "$task_id" "worktree_path")
  local branch
  branch=$(grove_db_task_get "$task_id" "branch")

  # Get repo github full name from config
  local github_full=""
  local repo_detail
  repo_detail=$(grove_config_repo_detail)
  local old_ifs="$IFS"
  while IFS='	' read -r rname rorg rgithub rpath; do
    if [ "$rname" = "$repo" ]; then
      github_full="$rgithub"
      break
    fi
  done <<EOF
$repo_detail
EOF
  IFS="$old_ifs"

  # Get repo local path
  local repo_path=""
  old_ifs="$IFS"
  while IFS='	' read -r rname rorg rgithub rpath; do
    if [ "$rname" = "$repo" ]; then
      repo_path="$rpath"
      break
    fi
  done <<EOF
$repo_detail
EOF
  IFS="$old_ifs"

  # Expand ~ in repo_path
  case "$repo_path" in
    "~/"*) repo_path="$HOME/${repo_path#\~/}" ;;
    "~")   repo_path="$HOME" ;;
  esac

  grove_info "Resuming $task_id: $title"

  # Verify worktree still exists; if not, recreate it
  if [ -n "$worktree_path" ] && [ ! -d "$worktree_path" ]; then
    grove_warn "Worktree missing at $worktree_path, recreating..."
    if [ -n "$repo_path" ] && [ -d "$repo_path" ] && [ -n "$branch" ]; then
      (cd "$repo_path" && git worktree add "$worktree_path" "$branch" 2>/dev/null) || {
        grove_die "Failed to recreate worktree at $worktree_path"
      }
      grove_success "Worktree recreated"
    else
      grove_die "Cannot recreate worktree: missing repo_path or branch"
    fi
  fi

  # Determine working directory
  local work_dir=""
  if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
    work_dir="$worktree_path"
  elif [ -n "$repo_path" ] && [ -d "$repo_path" ]; then
    work_dir="$repo_path"
  else
    grove_die "No valid working directory for task $task_id"
  fi

  # Build the resume prompt
  local resume_prompt
  resume_prompt="You are resuming work on task ${task_id}: \"${title}\"
Repository: ${repo} (${github_full})

## Previous Session Summary
${session_summary:-No previous session summary available.}

## Files Already Modified
${files_modified:-No files recorded from previous session.}

## What Comes Next
${next_steps:-Continue working on the task as described.}

## Instructions
The working tree already has your previous changes on branch ${branch:-main}.
Continue from where the last session left off.
When done, write a session summary to .grove/session-summary.md
Commit format: grove(${task_id}): description"

  # Check that claude is available
  if ! command -v claude >/dev/null 2>&1; then
    grove_die "claude CLI not found. Install Claude Code first."
  fi

  # Create new session
  local session_id
  session_id=$(grove_db_session_create "$task_id")

  # Set up log file
  mkdir -p "$GROVE_LOG_DIR"
  local log_file="$GROVE_LOG_DIR/${task_id}-session-${session_id}.log"
  grove_db_exec "UPDATE sessions SET output_log = '$(grove_db_escape "$log_file")' WHERE id = $session_id;"

  # Set task status to running
  grove_db_task_set_status "$task_id" "running"
  grove_db_task_set "$task_id" "session_id" "$session_id"
  grove_db_task_set "$task_id" "started_at" "$(grove_timestamp)"

  # Log resumed event
  grove_db_event "$task_id" "resumed" "Task resumed, session $session_id"

  grove_success "Session $session_id started"
  printf '  %sWorking dir:%s %s\n' "$DIM" "$RESET" "$work_dir"
  printf '  %sLog:%s         %s\n' "$DIM" "$RESET" "$log_file"

  # Spawn claude -p in the worktree
  (
    cd "$work_dir"
    claude -p "$resume_prompt" \
      --output-format stream-json \
      > "$log_file" 2>&1 &
    local worker_pid=$!

    # Store PID in session
    grove_db_exec "UPDATE sessions SET pid = $worker_pid WHERE id = $session_id;"

    grove_info "Worker PID: $worker_pid"

    # Monitor the stream
    grove_monitor_stream "$task_id" "$log_file"
    local monitor_result=$?

    # Read cost summary from monitor output or parse the log
    local cost_data
    cost_data=$(grove_monitor_parse_cost "$log_file")
    local cost_usd input_tokens output_tokens
    cost_usd=$(printf '%s' "$cost_data" | cut -f1)
    input_tokens=$(printf '%s' "$cost_data" | cut -f2)
    output_tokens=$(printf '%s' "$cost_data" | cut -f3)
    local total_tokens=$(( input_tokens + output_tokens ))

    # Update session with final cost
    grove_db_exec "UPDATE sessions SET cost_usd = ${cost_usd:-0}, tokens_used = ${total_tokens:-0}, ended_at = datetime('now'), status = 'completed' WHERE id = $session_id;"

    # Update task cost
    grove_db_exec "UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + ${cost_usd:-0}, tokens_used = COALESCE(tokens_used, 0) + ${total_tokens:-0}, updated_at = datetime('now') WHERE id = '$(grove_db_escape "$task_id")';"

    # Try to read session summary from worktree
    local summary_file="$work_dir/.grove/session-summary.md"
    if [ -f "$summary_file" ]; then
      local summary_content
      summary_content=$(cat "$summary_file")
      grove_db_task_set "$task_id" "session_summary" "$summary_content"
      grove_db_exec "UPDATE sessions SET summary = '$(grove_db_escape "$summary_content")' WHERE id = $session_id;"
    fi

    # Capture files modified via git
    local modified_files
    modified_files=$(cd "$work_dir" && git diff --name-only HEAD 2>/dev/null || echo "")
    if [ -z "$modified_files" ]; then
      modified_files=$(cd "$work_dir" && git diff --name-only 2>/dev/null || echo "")
    fi
    if [ -n "$modified_files" ]; then
      grove_db_task_set "$task_id" "files_modified" "$modified_files"
    fi

    # Set task to done (unless it was paused externally)
    local current_status
    current_status=$(grove_db_task_status "$task_id")
    if [ "$current_status" = "running" ]; then
      grove_db_task_set_status "$task_id" "done"
      grove_db_event "$task_id" "session_completed" "Session $session_id completed (cost: \$${cost_usd:-0})"
    fi

    grove_success "Session $session_id finished for $task_id"
    printf '  %sCost:%s    %s\n' "$DIM" "$RESET" "$(grove_dollars "${cost_usd:-0}")"
    printf '  %sTokens:%s  %s\n' "$DIM" "$RESET" "${total_tokens:-0}"
  )
}

grove_help_resume() {
  printf 'Usage: grove resume TASK_ID\n\n'
  printf 'Resume a paused task with full context from the previous session.\n\n'
  printf 'Grove injects the previous session summary, list of modified files,\n'
  printf 'and next steps into the worker prompt so it can pick up where the\n'
  printf 'last session left off.\n\n'
  printf 'The task must be in "paused" status. A new session is created and\n'
  printf 'the worker runs in the existing worktree.\n\n'
  printf 'Examples:\n'
  printf '  grove resume W-005     Resume paused task W-005\n'
}
