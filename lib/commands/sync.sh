#!/usr/bin/env bash
# lib/commands/sync.sh — grove sync
# Pull issues from configured GitHub repos, deduplicate, create/update tasks.

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Parse gh issue list JSON and emit tab-separated lines:
#   number\ttitle\tbody\tlabels_csv
# Uses python3 to parse JSON (no jq dependency).
_grove_sync_parse_issues() {
  python3 - << 'PYEOF'
import json, sys

raw = sys.stdin.read().strip()
if not raw or raw == "[]":
    sys.exit(0)

try:
    issues = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"JSON parse error: {e}", file=sys.stderr)
    sys.exit(1)

for issue in issues:
    number = issue.get("number", "")
    title = issue.get("title", "").replace("\t", " ").replace("\n", " ")
    body = issue.get("body") or ""
    # Collapse body to single line for DB storage
    body = body.replace("\t", " ").replace("\n", "\\n")
    labels = issue.get("labels", [])
    label_names = ",".join(l.get("name", "") for l in labels if isinstance(l, dict))
    print(f"{number}\t{title}\t{body}\t{label_names}")
PYEOF
}

# Derive a task-ID prefix from a repo short name.
# First letter, uppercased. bash 3.2 compatible (no ${var^^}).
_grove_sync_prefix() {
  local name="$1"
  local first
  first=$(printf '%s' "$name" | cut -c1)
  printf '%s' "$first" | tr 'a-z' 'A-Z'
}

# ---------------------------------------------------------------------------
# Main command
# ---------------------------------------------------------------------------

grove_cmd_sync() {
  local target_repo=""
  local dry_run=0

  # Parse options
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove sync --repo NAME"
        fi
        target_repo="$2"
        shift 2
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      -h|--help)
        grove_help_sync
        return 0
        ;;
      *)
        grove_die "Unknown option: $1. See 'grove help sync'."
        ;;
    esac
  done

  grove_require gh python3 sqlite3
  grove_require_db
  grove_require_config

  # Verify gh is authenticated
  if ! gh auth status >/dev/null 2>&1; then
    grove_die "GitHub CLI not authenticated. Run 'gh auth login' first."
  fi

  # Get configured repos
  local repo_detail
  repo_detail=$(grove_config_repo_detail)

  if [ -z "$repo_detail" ]; then
    grove_warn "No repos configured. Add repos to $GROVE_CONFIG"
    return 0
  fi

  if [ "$dry_run" = "1" ]; then
    grove_header "Sync (dry run)"
  else
    grove_header "Sync"
  fi

  local total_new=0
  local total_updated=0
  local total_repos=0

  local IFS_SAVE="$IFS"
  while IFS='	' read -r name org github path; do
    [ -z "$name" ] && continue

    # If --repo specified, skip non-matching repos
    if [ -n "$target_repo" ] && [ "$name" != "$target_repo" ]; then
      continue
    fi

    total_repos=$(( total_repos + 1 ))

    grove_info "Syncing ${BOLD}${name}${RESET} (${github})..."

    # Fetch issues via gh CLI
    local issues_json
    issues_json=$(gh issue list --repo "$github" --state open --limit 100 \
      --json number,title,body,labels,state 2>&1) || {
      grove_warn "  Failed to fetch issues from $github — skipping"
      grove_debug "  gh error: $issues_json"
      continue
    }

    # Upsert repo into repos table (unless dry run)
    local escaped_name
    local escaped_org
    local escaped_github
    local escaped_path
    escaped_name=$(grove_db_escape "$name")
    escaped_org=$(grove_db_escape "$org")
    escaped_github=$(grove_db_escape "$github")
    escaped_path=$(grove_db_escape "$path")

    if [ "$dry_run" = "0" ]; then
      grove_db_exec "INSERT INTO repos (name, org, github_full, local_path)
        VALUES ('$escaped_name', '$escaped_org', '$escaped_github', '$escaped_path')
        ON CONFLICT(name) DO UPDATE SET
          org = '$escaped_org',
          github_full = '$escaped_github',
          local_path = '$escaped_path';"
    fi

    # Parse issues
    local parsed
    parsed=$(printf '%s' "$issues_json" | _grove_sync_parse_issues)

    if [ -z "$parsed" ]; then
      grove_info "  No open issues found."
      # Still update last_synced
      if [ "$dry_run" = "0" ]; then
        grove_db_exec "UPDATE repos SET last_synced = datetime('now') WHERE name = '$escaped_name';"
      fi
      continue
    fi

    local repo_new=0
    local repo_updated=0
    local prefix
    prefix=$(_grove_sync_prefix "$name")

    while IFS='	' read -r issue_num issue_title issue_body issue_labels; do
      [ -z "$issue_num" ] && continue

      local source_ref="${name}#${issue_num}"
      local escaped_ref
      escaped_ref=$(grove_db_escape "$source_ref")

      # Check if task already exists for this issue
      local existing_id
      existing_id=$(grove_db_get "SELECT id FROM tasks WHERE source_type = 'github' AND source_ref = '$escaped_ref';")

      if [ -z "$existing_id" ]; then
        # New issue — create task
        if [ "$dry_run" = "1" ]; then
          printf '  %s+ NEW%s  %s — %s\n' "$GREEN" "$RESET" "$source_ref" "$(grove_truncate "$issue_title" 50)"
        else
          local task_id
          task_id=$(grove_db_next_task_id "$prefix")

          local escaped_title
          local escaped_body
          escaped_title=$(grove_db_escape "$issue_title")
          escaped_body=$(grove_db_escape "$issue_body")

          grove_db_exec "INSERT INTO tasks (id, repo, source_type, source_ref, title, description, status, priority)
            VALUES ('$task_id', '$escaped_name', 'github', '$escaped_ref', '$escaped_title', '$escaped_body', 'ingested', 50);"

          grove_db_event "$task_id" "synced" "Synced from GitHub issue $source_ref"

          grove_debug "  Created $task_id from $source_ref"
        fi
        repo_new=$(( repo_new + 1 ))
      else
        # Existing task — check if title or description changed
        local current_title
        local current_desc
        current_title=$(grove_db_task_get "$existing_id" "title")
        current_desc=$(grove_db_task_get "$existing_id" "description")

        local escaped_title
        local escaped_body
        escaped_title=$(grove_db_escape "$issue_title")
        escaped_body=$(grove_db_escape "$issue_body")

        local changed=0
        if [ "$current_title" != "$issue_title" ]; then
          changed=1
        fi
        if [ "$current_desc" != "$issue_body" ]; then
          changed=1
        fi

        if [ "$changed" = "1" ]; then
          if [ "$dry_run" = "1" ]; then
            printf '  %s~ UPD%s  %s (%s) — %s\n' "$YELLOW" "$RESET" "$source_ref" "$existing_id" "$(grove_truncate "$issue_title" 50)"
          else
            grove_db_exec "UPDATE tasks SET title = '$escaped_title', description = '$escaped_body', updated_at = datetime('now') WHERE id = '$(grove_db_escape "$existing_id")';"
            grove_db_event "$existing_id" "synced" "Updated from GitHub issue $source_ref"
          fi
          repo_updated=$(( repo_updated + 1 ))
        fi
      fi
    done << ISSUES
$parsed
ISSUES

    # Update last_synced
    if [ "$dry_run" = "0" ]; then
      grove_db_exec "UPDATE repos SET last_synced = datetime('now') WHERE name = '$escaped_name';"
    fi

    # Per-repo summary
    if [ "$repo_new" -gt 0 ] || [ "$repo_updated" -gt 0 ]; then
      local parts=""
      if [ "$repo_new" -gt 0 ]; then
        parts="${GREEN}${repo_new} new${RESET}"
      fi
      if [ "$repo_updated" -gt 0 ]; then
        if [ -n "$parts" ]; then
          parts="$parts, "
        fi
        parts="${parts}${YELLOW}${repo_updated} updated${RESET}"
      fi
      printf '  %s\n' "$parts"
    else
      printf '  %s(no changes)%s\n' "$DIM" "$RESET"
    fi

    total_new=$(( total_new + repo_new ))
    total_updated=$(( total_updated + repo_updated ))

  done << EOF
$repo_detail
EOF
  IFS="$IFS_SAVE"

  # Check if target repo was found
  if [ -n "$target_repo" ] && [ "$total_repos" = "0" ]; then
    grove_warn "Repo '$target_repo' not found in config."
    return 1
  fi

  # Final summary
  printf '\n'
  if [ "$dry_run" = "1" ]; then
    grove_info "Dry run complete: ${BOLD}${total_new}${RESET} would be created, ${BOLD}${total_updated}${RESET} would be updated"
  else
    if [ "$total_new" -gt 0 ] || [ "$total_updated" -gt 0 ]; then
      grove_success "Synced: ${BOLD}${total_new}${RESET} new tasks, ${BOLD}${total_updated}${RESET} updated"
    else
      grove_success "Everything up to date."
    fi
    # Log sync event
    grove_db_event "" "sync" "Synced $total_repos repo(s): $total_new new, $total_updated updated"
  fi
}

grove_help_sync() {
  printf 'Usage: grove sync [OPTIONS]\n\n'
  printf 'Pull open issues from configured GitHub repos and create/update\n'
  printf 'tasks in the Grove database. Deduplicates by source reference.\n\n'
  printf 'Options:\n'
  printf '  --repo NAME     Sync only the named repo\n'
  printf '  --dry-run       Show what would be synced without making changes\n\n'
  printf 'Examples:\n'
  printf '  grove sync              Sync all configured repos\n'
  printf '  grove sync --repo wheels   Sync only the wheels repo\n'
  printf '  grove sync --dry-run    Preview without changes\n\n'
  printf 'Requires:\n'
  printf '  - gh CLI installed and authenticated (gh auth login)\n'
  printf '  - Repos configured in %s\n' "$GROVE_CONFIG"
}
