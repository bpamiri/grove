#!/usr/bin/env bash
# lib/commands/repos.sh — grove repos
# List configured repositories with status.

grove_cmd_repos() {
  grove_require_config
  grove_header "Configured Repositories"

  local repo_data
  repo_data=$(grove_config_repo_detail)

  if [ -z "$repo_data" ]; then
    grove_warn "No repos configured."
    printf '\nAdd repos to: %s\n' "$GROVE_CONFIG"
    return 0
  fi

  # Print header
  printf '%s%-12s %-14s %-26s %-30s%s\n' \
    "$BOLD" "NAME" "ORG" "GITHUB" "PATH" "$RESET"
  printf '%-12s %-14s %-26s %-30s\n' \
    "────────────" "──────────────" "──────────────────────────" "──────────────────────────────"

  # Print each repo
  local IFS_SAVE="$IFS"
  while IFS='	' read -r name org github path; do
    [ -z "$name" ] && continue

    # Expand ~ in path for display
    local expanded_path
    expanded_path="$path"
    case "$expanded_path" in "~/"*) expanded_path="$HOME/${expanded_path#\~/}" ;; "~") expanded_path="$HOME" ;; esac

    # Check if local path exists
    local path_badge=""
    if [ -d "$expanded_path" ]; then
      path_badge="${GREEN}ok${RESET}"
    else
      path_badge="${RED}missing${RESET}"
    fi

    # Check for synced tasks (if db exists)
    local task_count=""
    if [ -f "$GROVE_DB" ]; then
      local tc
      tc=$(sqlite3 "$GROVE_DB" "SELECT COUNT(*) FROM tasks WHERE repo = '$(grove_db_escape "$name")';")
      if [ "$tc" -gt 0 ] 2>/dev/null; then
        task_count=" ${DIM}(${tc} tasks)${RESET}"
      fi
    fi

    # Check last synced (if db exists)
    local synced_info=""
    if [ -f "$GROVE_DB" ]; then
      local last_synced
      last_synced=$(sqlite3 "$GROVE_DB" "SELECT last_synced FROM repos WHERE name = '$(grove_db_escape "$name")';")
      if [ -n "$last_synced" ]; then
        synced_info=" ${DIM}synced $(grove_relative_time "$last_synced")${RESET}"
      fi
    fi

    printf '%-12s %-14s %-26s %s [%b]%b%b\n' \
      "$name" "$org" "$github" "$(grove_truncate "$path" 28)" "$path_badge" "$task_count" "$synced_info"
  done << EOF
$repo_data
EOF
  IFS="$IFS_SAVE"

  printf '\n'
}

grove_help_repos() {
  printf 'Usage: grove repos\n\n'
  printf 'List all configured repositories with their org, GitHub path,\n'
  printf 'local directory, sync status, and task counts.\n\n'
  printf 'Repos are configured in: %s\n' "$GROVE_CONFIG"
}
