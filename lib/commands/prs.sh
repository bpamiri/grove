#!/usr/bin/env bash
# lib/commands/prs.sh — grove prs
# List all open Grove PRs across configured repos.

# Internal: fetch and display PRs for a single repo.
# Args: github_full repo_name branch_prefix
_grove_prs_for_repo() {
  local github_full="$1"
  local repo_name="$2"
  local branch_prefix="$3"

  local json
  json=$(gh pr list --repo "$github_full" \
    --json number,title,state,headRefName,url,createdAt,isDraft,reviewDecision \
    --limit 50 2>/dev/null) || return 0

  # Filter to grove branches and format output
  python3 - "$json" "$branch_prefix" "$repo_name" << 'PYEOF'
import sys, json

raw = sys.argv[1]
prefix = sys.argv[2]
repo = sys.argv[3]

try:
    prs = json.loads(raw)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

for pr in prs:
    branch = pr.get("headRefName", "")
    if not branch.startswith(prefix):
        continue
    number = pr.get("number", "")
    title = pr.get("title", "")
    state = pr.get("state", "OPEN")
    is_draft = pr.get("isDraft", False)
    review = pr.get("reviewDecision", "")
    created = pr.get("createdAt", "")
    url = pr.get("url", "")

    # Determine display status
    if is_draft:
        status = "draft"
    elif review == "APPROVED":
        status = "approved"
    elif review == "CHANGES_REQUESTED":
        status = "changes"
    else:
        status = "open"

    # Output tab-separated for bash consumption
    print(f"{number}\t{repo}\t{title}\t{status}\t{branch}\t{created}\t{url}")
PYEOF
}

grove_cmd_prs() {
  grove_require gh
  grove_require_db
  grove_require_config

  local filter_repo=""

  # Parse arguments
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo|-r)
        if [ -z "${2:-}" ]; then
          grove_die "Usage: grove prs --repo NAME"
        fi
        filter_repo="$2"
        shift 2
        ;;
      --repo=*)
        filter_repo="${1#--repo=}"
        shift
        ;;
      -h|--help)
        grove_help_prs
        return 0
        ;;
      *)
        grove_warn "Unknown option: $1"
        shift
        ;;
    esac
  done

  local repo_data
  repo_data=$(grove_config_repo_detail)

  if [ -z "$repo_data" ]; then
    grove_info "No repos configured. Run 'grove repos' to check."
    return 0
  fi

  grove_header "Open Grove PRs"

  local all_prs=""
  local IFS_SAVE="$IFS"

  while IFS='	' read -r name org github path; do
    [ -z "$name" ] && continue

    # Apply repo filter
    if [ -n "$filter_repo" ] && [ "$name" != "$filter_repo" ]; then
      continue
    fi

    # Get branch prefix from repos table, default to grove/
    local branch_prefix
    branch_prefix=$(grove_db_get "SELECT branch_prefix FROM repos WHERE name = '$(grove_db_escape "$name")';")
    if [ -z "$branch_prefix" ]; then
      branch_prefix="grove/"
    fi

    grove_debug "Checking $github for PRs with prefix $branch_prefix"

    local repo_prs
    repo_prs=$(_grove_prs_for_repo "$github" "$name" "$branch_prefix")
    if [ -n "$repo_prs" ]; then
      if [ -n "$all_prs" ]; then
        all_prs="$all_prs
$repo_prs"
      else
        all_prs="$repo_prs"
      fi
    fi
  done << EOF
$repo_data
EOF
  IFS="$IFS_SAVE"

  if [ -z "$all_prs" ]; then
    grove_info "No open Grove PRs found."
    return 0
  fi

  # Print header
  printf '%s%-6s %-12s %-32s %-10s %-8s %-14s%s\n' \
    "$BOLD" "PR#" "REPO" "TITLE" "STATUS" "TASK" "CREATED" "$RESET"
  printf '%-6s %-12s %-32s %-10s %-8s %-14s\n' \
    "──────" "────────────" "────────────────────────────────" "──────────" "────────" "──────────────"

  while IFS='	' read -r pr_num repo title status branch created url; do
    [ -z "$pr_num" ] && continue

    local display_title
    display_title=$(grove_truncate "$title" 30)

    # Cross-reference with tasks table by pr_number or branch
    local task_id=""
    task_id=$(grove_db_get "SELECT id FROM tasks WHERE (pr_number = '$pr_num' AND repo = '$(grove_db_escape "$repo")') OR branch = '$(grove_db_escape "$branch")' LIMIT 1;")
    if [ -z "$task_id" ]; then
      task_id="-"
    fi

    # Status badge
    local status_display
    case "$status" in
      draft)    status_display=$(grove_badge "draft" "yellow") ;;
      approved) status_display=$(grove_badge "approved" "green") ;;
      changes)  status_display=$(grove_badge "changes" "red") ;;
      *)        status_display=$(grove_badge "open" "blue") ;;
    esac

    # Relative time for created
    local created_display
    created_display=$(grove_relative_time "$created" 2>/dev/null || echo "$created")

    printf '%-6s %-12s %-32s %-10b %-8s %s\n' \
      "#$pr_num" "$repo" "$display_title" "$status_display" "$task_id" "$created_display"
  done << EOF
$all_prs
EOF

  # Count
  local pr_count
  pr_count=$(printf '%s\n' "$all_prs" | wc -l | tr -d ' ')
  printf '\n%s%s PR(s) found%s\n' "$DIM" "$pr_count" "$RESET"
}

grove_help_prs() {
  printf 'Usage: grove prs [OPTIONS]\n\n'
  printf 'List all open Grove PRs across configured repos.\n\n'
  printf 'Only shows PRs whose branch matches the configured branch\n'
  printf 'prefix (default: grove/). Cross-references with tasks DB.\n\n'
  printf 'Options:\n'
  printf '  --repo, -r NAME     Show PRs for a specific repo only\n\n'
  printf 'Requires: gh CLI authenticated\n\n'
  printf 'Examples:\n'
  printf '  grove prs               All Grove PRs across repos\n'
  printf '  grove prs --repo titan  PRs for the titan repo only\n'
}
