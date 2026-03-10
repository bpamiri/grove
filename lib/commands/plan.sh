#!/usr/bin/env bash
# lib/commands/plan.sh — grove plan
# Assign strategy and cost estimates to tasks.

# Detect strategy from task description using keyword heuristics.
# Prints strategy name to stdout.
_grove_detect_strategy() {
  local desc="$1"
  local desc_lower
  desc_lower=$(printf '%s' "$desc" | python3 -c "import sys; print(sys.stdin.read().lower())")

  # Check for sweep-type keywords
  case "$desc_lower" in
    *audit*|*"check all"*|*validate*|*"review all"*|*scan*|*lint*|*"check each"*)
      printf 'sweep'
      return 0
      ;;
  esac

  # Check for pipeline-type keywords
  case "$desc_lower" in
    *"cross-repo"*|*"cross repo"*|*"multiple repos"*|*pipeline*|*"end-to-end"*|*"end to end"*)
      printf 'pipeline'
      return 0
      ;;
  esac

  # Check for team-type keywords
  case "$desc_lower" in
    *refactor*|*redesign*|*overhaul*|*migration*|*rewrite*|*rearchitect*|*"large scale"*|*"major change"*)
      printf 'team'
      return 0
      ;;
  esac

  # Default
  printf 'solo'
}

# Estimate team size for team strategy based on scope words.
# Prints integer to stdout.
_grove_estimate_team_size() {
  local desc="$1"
  local desc_lower
  desc_lower=$(printf '%s' "$desc" | python3 -c "import sys; print(sys.stdin.read().lower())")

  case "$desc_lower" in
    *overhaul*|*rewrite*|*rearchitect*|*"large scale"*|*"major"*)
      printf '3'
      ;;
    *)
      printf '2'
      ;;
  esac
}

# Estimate cost based on strategy.
# Prints float to stdout.
_grove_estimate_cost() {
  local strategy="$1"
  local description="$2"

  case "$strategy" in
    solo)
      printf '1.50'
      ;;
    team)
      local size
      size=$(_grove_estimate_team_size "$description")
      python3 -c "print(f'{$size * 2.00:.2f}')"
      ;;
    sweep)
      # Estimate modules based on description length / complexity
      # Base: 3 modules at $1.00 each
      printf '3.00'
      ;;
    pipeline)
      printf '5.00'
      ;;
    *)
      printf '1.50'
      ;;
  esac
}

# Plan a single task: detect strategy, estimate cost, update DB.
_grove_plan_task() {
  local task_id="$1"

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_error "Task not found: $task_id"
    return 1
  fi

  local current_status
  current_status=$(grove_db_task_status "$task_id")

  # Allow planning from ingested or planned status
  case "$current_status" in
    ingested|planned)
      ;;
    *)
      grove_warn "Task $task_id is '$current_status' — skipping (must be ingested or planned)."
      return 0
      ;;
  esac

  local title
  local description
  title=$(grove_db_task_get "$task_id" "title")
  description=$(grove_db_task_get "$task_id" "description")
  local full_text="$title $description"

  # Detect strategy
  local strategy
  strategy=$(_grove_detect_strategy "$full_text")

  # Estimate cost
  local est_cost
  est_cost=$(_grove_estimate_cost "$strategy" "$full_text")

  # Build strategy config for team
  local strategy_config=""
  if [ "$strategy" = "team" ]; then
    local team_size
    team_size=$(_grove_estimate_team_size "$full_text")
    strategy_config="size=$team_size"
  fi

  # Update task
  grove_db_task_set "$task_id" "strategy" "$strategy"
  grove_db_task_set "$task_id" "estimated_cost" "$est_cost"
  if [ -n "$strategy_config" ]; then
    grove_db_task_set "$task_id" "strategy_config" "$strategy_config"
  fi
  grove_db_task_set_status "$task_id" "planned"

  # Log event
  grove_db_event "$task_id" "planned" "Strategy: $strategy, Est: \$$est_cost"

  local repo
  repo=$(grove_db_task_get "$task_id" "repo")
  grove_success "Planned $task_id ($repo): strategy=$strategy est=$(grove_dollars "$est_cost")"

  # Auto-promote to ready if under auto_approve threshold
  local auto_approve
  auto_approve=$(grove_budget_get "auto_approve_under" 2>/dev/null || echo "0")
  if [ -n "$auto_approve" ] && [ "$auto_approve" != "0" ]; then
    local under_budget
    under_budget=$(python3 -c "print('yes' if float('$est_cost') < float('$auto_approve') else 'no')")
    if [ "$under_budget" = "yes" ]; then
      grove_db_task_set_status "$task_id" "ready"
      grove_db_event "$task_id" "auto_approved" "Cost \$$est_cost under auto-approve threshold \$$auto_approve"
      grove_info "  Auto-promoted to ready (under $(grove_dollars "$auto_approve") threshold)"
    fi
  fi
}

grove_cmd_plan() {
  grove_require_db

  local task_id="${1:-}"

  if [ -n "$task_id" ]; then
    # Plan a specific task
    _grove_plan_task "$task_id"
  else
    # Plan all ingested tasks
    grove_header "Planning Tasks"

    local ingested
    ingested=$(grove_db_tasks_by_status "ingested")

    if [ -z "$ingested" ]; then
      grove_info "No ingested tasks to plan."
      return 0
    fi

    local count=0
    local IFS_SAVE="$IFS"
    while IFS='	' read -r id repo title; do
      [ -z "$id" ] && continue
      _grove_plan_task "$id"
      count=$(( count + 1 ))
    done << EOF
$ingested
EOF
    IFS="$IFS_SAVE"

    printf '\n'
    grove_success "Planned $count task(s)."
  fi
}

grove_help_plan() {
  printf 'Usage: grove plan [TASK_ID]\n\n'
  printf 'Assign strategy and cost estimates to tasks.\n\n'
  printf 'With a TASK_ID, plans that specific task.\n'
  printf 'With no arguments, plans all "ingested" tasks.\n\n'
  printf 'Strategy detection (keyword heuristics):\n'
  printf '  solo     — Default for single-focus tasks\n'
  printf '  team     — refactor, redesign, overhaul, migration\n'
  printf '  sweep    — audit, validate, review all, scan\n'
  printf '  pipeline — cross-repo, end-to-end\n\n'
  printf 'After planning, tasks with estimated cost under the\n'
  printf 'auto_approve_under budget threshold are auto-promoted to "ready".\n\n'
  printf 'Examples:\n'
  printf '  grove plan W-001      Plan a specific task\n'
  printf '  grove plan            Plan all ingested tasks\n'
}
