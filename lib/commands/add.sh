#!/usr/bin/env bash
# lib/commands/add.sh — grove add
# Create a new task (quick one-liner or interactive).

grove_cmd_add() {
  grove_require_db
  grove_require_config

  local description=""
  local repo=""
  local args_done=0

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove add --repo NAME"
        fi
        repo="$2"
        shift 2
        ;;
      --repo=*)
        repo="${1#--repo=}"
        shift
        ;;
      -h|--help)
        grove_help_add
        return 0
        ;;
      *)
        if [ -z "$description" ]; then
          description="$1"
        else
          description="$description $1"
        fi
        shift
        ;;
    esac
  done

  # Interactive mode if no description provided
  if [ -z "$description" ]; then
    grove_header "Add Task"
    printf 'Describe the task:\n'
    printf '> '
    read -r description
    if [ -z "$description" ]; then
      grove_die "Task description cannot be empty."
    fi
  fi

  # Get configured repos
  local repos_list
  repos_list=$(grove_config_repos)
  if [ -z "$repos_list" ]; then
    grove_die "No repos configured. Add repos to $GROVE_CONFIG first."
  fi

  # If no repo specified, try to detect from description keywords
  if [ -z "$repo" ]; then
    local matched_repo=""
    local match_count=0
    local r
    while IFS= read -r r; do
      [ -z "$r" ] && continue
      # Case-insensitive match: check if repo name appears in description
      local desc_lower
      local r_lower
      desc_lower=$(printf '%s' "$description" | python3 -c "import sys; print(sys.stdin.read().lower())")
      r_lower=$(printf '%s' "$r" | python3 -c "import sys; print(sys.stdin.read().lower())")
      case "$desc_lower" in
        *"$r_lower"*)
          matched_repo="$r"
          match_count=$(( match_count + 1 ))
          ;;
      esac
    done << EOF
$repos_list
EOF

    if [ "$match_count" -eq 1 ]; then
      repo="$matched_repo"
      grove_info "Detected repo: $repo"
    elif [ "$match_count" -gt 1 ]; then
      grove_info "Multiple repos detected in description."
    fi
  fi

  # If still no repo, prompt user to choose
  if [ -z "$repo" ]; then
    local repo_options=()
    local r
    while IFS= read -r r; do
      [ -z "$r" ] && continue
      repo_options=("${repo_options[@]}" "$r")
    done << EOF
$repos_list
EOF

    if [ "${#repo_options[@]}" -eq 1 ]; then
      repo="${repo_options[0]}"
      grove_info "Using repo: $repo"
    else
      repo=$(grove_choose "Which repo?" "${repo_options[@]}")
    fi
  fi

  # Validate repo exists in config
  local repo_found=0
  local r
  while IFS= read -r r; do
    if [ "$r" = "$repo" ]; then
      repo_found=1
      break
    fi
  done << EOF
$repos_list
EOF

  if [ "$repo_found" -eq 0 ]; then
    grove_die "Repo '$repo' not found in config. Available: $(printf '%s' "$repos_list" | tr '\n' ' ')"
  fi

  # Generate task ID: first letter of repo name, uppercased
  local prefix
  prefix=$(printf '%s' "$repo" | cut -c1 | python3 -c "import sys; print(sys.stdin.read().strip().upper())")
  local task_id
  task_id=$(grove_db_next_task_id "$prefix")

  # Escape and insert
  local esc_desc
  local esc_repo
  local esc_title
  esc_desc=$(grove_db_escape "$description")
  esc_repo=$(grove_db_escape "$repo")
  esc_title=$(grove_db_escape "$description")

  grove_db_exec "INSERT INTO tasks (id, repo, source_type, title, description, status, priority) VALUES ('$task_id', '$esc_repo', 'manual', '$esc_title', '$esc_desc', 'ingested', 50);"

  # Log event
  grove_db_event "$task_id" "created" "Task created manually"

  grove_success "Created $task_id: $description"
  printf '  %sRepo:%s     %s\n' "$DIM" "$RESET" "$repo"
  printf '  %sStatus:%s   ingested\n' "$DIM" "$RESET"
  printf '  %sPriority:%s 50\n' "$DIM" "$RESET"

  # Interactive mode: suggest strategy
  if [ -t 0 ]; then
    printf '\n'
    # Ask to start now
    if type grove_cmd_work >/dev/null 2>&1; then
      if grove_confirm "Start working on this now?"; then
        grove_cmd_work "$task_id"
        return $?
      fi
    else
      grove_info "Next: grove plan $task_id"
    fi
  fi
}

grove_help_add() {
  printf 'Usage: grove add [DESCRIPTION] [--repo NAME]\n\n'
  printf 'Create a new task. Two modes:\n\n'
  printf '  Quick:       grove add "Fix route parsing" --repo wheels\n'
  printf '  Interactive: grove add\n\n'
  printf 'Options:\n'
  printf '  --repo NAME    Assign to a specific repository\n\n'
  printf 'In interactive mode, Grove will prompt for a description and\n'
  printf 'try to detect the repo from keywords. If ambiguous, you choose\n'
  printf 'from configured repos.\n\n'
  printf 'The task starts in "ingested" status. Run "grove plan TASK"\n'
  printf 'to assign a strategy, or "grove work TASK" to start immediately.\n'
}
