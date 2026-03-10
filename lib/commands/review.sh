#!/usr/bin/env bash
# lib/commands/review.sh — grove review
# Interactive PR review workflow.

# Internal: collect all grove PRs as tab-separated lines.
# Output: pr_num, repo, title, status, branch, github_full, url
_grove_review_collect_prs() {
  local repo_data
  repo_data=$(grove_config_repo_detail)
  [ -z "$repo_data" ] && return 0

  local IFS_SAVE="$IFS"
  while IFS='	' read -r name org github path; do
    [ -z "$name" ] && continue

    local branch_prefix
    branch_prefix=$(grove_db_get "SELECT branch_prefix FROM repos WHERE name = '$(grove_db_escape "$name")';")
    if [ -z "$branch_prefix" ]; then
      branch_prefix="grove/"
    fi

    local json
    json=$(gh pr list --repo "$github" \
      --json number,title,state,headRefName,url,createdAt,isDraft,reviewDecision \
      --limit 50 2>/dev/null) || continue

    python3 - "$json" "$branch_prefix" "$name" "$github" << 'PYEOF'
import sys, json

raw = sys.argv[1]
prefix = sys.argv[2]
repo = sys.argv[3]
github_full = sys.argv[4]

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
    is_draft = pr.get("isDraft", False)
    review = pr.get("reviewDecision", "")
    url = pr.get("url", "")

    if is_draft:
        status = "draft"
    elif review == "APPROVED":
        status = "approved"
    elif review == "CHANGES_REQUESTED":
        status = "changes"
    else:
        status = "open"

    print(f"{number}\t{repo}\t{title}\t{status}\t{branch}\t{github_full}\t{url}")
PYEOF
  done << EOF
$repo_data
EOF
  IFS="$IFS_SAVE"
}

# Internal: show the review menu loop for a selected PR.
# Args: pr_num repo title status branch github_full url
_grove_review_menu() {
  local pr_num="$1"
  local repo="$2"
  local title="$3"
  local status="$4"
  local branch="$5"
  local github_full="$6"
  local url="$7"

  printf '\n%sPR #%s%s — %s (%s)\n' "$BOLD" "$pr_num" "$RESET" "$title" "$repo"
  printf '%s%s%s\n' "$DIM" "$url" "$RESET"
  printf '\n'

  # Show PR description
  grove_info "Fetching PR details..."
  local pr_body
  pr_body=$(gh pr view "$pr_num" --repo "$github_full" --json body,additions,deletions,changedFiles 2>/dev/null)
  if [ -n "$pr_body" ]; then
    python3 - "$pr_body" << 'PYEOF'
import sys, json
try:
    data = json.loads(sys.argv[1])
    adds = data.get("additions", 0)
    dels = data.get("deletions", 0)
    files = data.get("changedFiles", 0)
    body = data.get("body", "").strip()
    print(f"  Files changed: {files}  (+{adds} -{dels})")
    if body:
        # Show first 5 lines of body
        lines = body.split("\n")[:5]
        print()
        for line in lines:
            print(f"  {line}")
        if len(body.split("\n")) > 5:
            print("  ...")
except (json.JSONDecodeError, ValueError):
    pass
PYEOF
    printf '\n'
  fi

  # Show CI status
  local ci_status
  ci_status=$(gh pr checks "$pr_num" --repo "$github_full" 2>/dev/null || echo "")
  if [ -n "$ci_status" ]; then
    grove_info "CI checks:"
    printf '%s\n\n' "$ci_status"
  fi

  # Review loop
  while true; do
    printf '%s[o]%s Open in browser  ' "$BOLD" "$RESET"
    printf '%s[d]%s Diff  ' "$BOLD" "$RESET"
    printf '%s[a]%s Approve  ' "$BOLD" "$RESET"
    printf '%s[m]%s Merge  ' "$BOLD" "$RESET"
    printf '%s[c]%s Comment  ' "$BOLD" "$RESET"
    printf '%s[q]%s Quit\n' "$BOLD" "$RESET"
    printf 'Action: '
    read -r action

    case "$action" in
      o)
        gh pr view "$pr_num" --repo "$github_full" --web 2>/dev/null
        grove_success "Opened in browser."
        ;;
      d)
        gh pr diff "$pr_num" --repo "$github_full" 2>/dev/null
        ;;
      a)
        if grove_confirm "Approve PR #$pr_num?"; then
          gh pr review "$pr_num" --repo "$github_full" --approve 2>/dev/null
          grove_success "PR #$pr_num approved."
        fi
        ;;
      m)
        if grove_confirm "Merge PR #$pr_num?"; then
          if gh pr merge "$pr_num" --repo "$github_full" --merge 2>/dev/null; then
            grove_success "PR #$pr_num merged."

            # Update linked task
            local task_id
            task_id=$(grove_db_get "SELECT id FROM tasks WHERE (pr_number = '$pr_num' AND repo = '$(grove_db_escape "$repo")') OR branch = '$(grove_db_escape "$branch")' LIMIT 1;")
            if [ -n "$task_id" ]; then
              local current_status
              current_status=$(grove_db_task_status "$task_id")
              case "$current_status" in
                review|done)
                  grove_db_task_set_status "$task_id" "completed"
                  grove_db_task_set "$task_id" "completed_at" "$(grove_timestamp)"
                  grove_db_event "$task_id" "pr_merged" "PR #$pr_num merged in $repo"
                  grove_success "Task $task_id marked completed."
                  ;;
                *)
                  grove_db_event "$task_id" "pr_merged" "PR #$pr_num merged in $repo"
                  grove_info "Task $task_id is '$current_status' — update status manually if needed."
                  ;;
              esac
            fi
            return 0
          else
            grove_error "Merge failed. Check CI status or conflicts."
          fi
        fi
        ;;
      c)
        printf 'Comment: '
        read -r comment_text
        if [ -n "$comment_text" ]; then
          gh pr comment "$pr_num" --repo "$github_full" --body "$comment_text" 2>/dev/null
          grove_success "Comment added."
        fi
        ;;
      q)
        return 0
        ;;
      *)
        grove_warn "Unknown action: $action"
        ;;
    esac
    printf '\n'
  done
}

grove_cmd_review() {
  # Parse arguments before doing any work
  local arg
  for arg in "$@"; do
    case "$arg" in
      -h|--help)
        grove_help_review
        return 0
        ;;
    esac
  done

  grove_require gh
  grove_require_db
  grove_require_config

  grove_info "Fetching open Grove PRs..."

  local all_prs
  all_prs=$(_grove_review_collect_prs)

  if [ -z "$all_prs" ]; then
    grove_info "No open Grove PRs to review."
    return 0
  fi

  # Build selection list
  local options=""
  local count=0
  local IFS_SAVE="$IFS"

  # Store PR lines in a temp approach using line numbers
  local pr_lines=""
  while IFS='	' read -r pr_num repo title status branch github_full url; do
    [ -z "$pr_num" ] && continue
    count=$(( count + 1 ))
    local display
    display=$(grove_truncate "$title" 40)
    printf '  %s[%d]%s #%-5s %-10s %s ' "$BOLD" "$count" "$RESET" "$pr_num" "$repo" "$display"
    grove_badge "$status" "$(
      case "$status" in
        draft)    printf 'yellow' ;;
        approved) printf 'green' ;;
        changes)  printf 'red' ;;
        *)        printf 'blue' ;;
      esac
    )"
    printf '\n'
  done << EOF
$all_prs
EOF
  IFS="$IFS_SAVE"

  if [ "$count" -eq 0 ]; then
    grove_info "No open Grove PRs to review."
    return 0
  fi

  printf '\nSelect PR to review (1-%d, q to quit): ' "$count"
  read -r selection

  if [ "$selection" = "q" ] || [ "$selection" = "Q" ]; then
    return 0
  fi

  # Validate selection
  if ! [ "$selection" -ge 1 ] 2>/dev/null || ! [ "$selection" -le "$count" ] 2>/dev/null; then
    grove_error "Invalid selection."
    return 1
  fi

  # Get the selected PR line
  local line_num=0
  local IFS_SAVE="$IFS"
  while IFS='	' read -r pr_num repo title status branch github_full url; do
    [ -z "$pr_num" ] && continue
    line_num=$(( line_num + 1 ))
    if [ "$line_num" -eq "$selection" ]; then
      _grove_review_menu "$pr_num" "$repo" "$title" "$status" "$branch" "$github_full" "$url"
      IFS="$IFS_SAVE"
      return 0
    fi
  done << EOF
$all_prs
EOF
  IFS="$IFS_SAVE"

  grove_error "Could not find selected PR."
  return 1
}

grove_help_review() {
  printf 'Usage: grove review\n\n'
  printf 'Interactive PR review workflow for Grove PRs.\n\n'
  printf 'Fetches all open PRs with grove/ branch prefix, lets you\n'
  printf 'pick one, then provides an interactive menu:\n\n'
  printf '  [o] Open in browser     [d] Show diff\n'
  printf '  [a] Approve PR          [m] Merge PR\n'
  printf '  [c] Add comment         [q] Quit\n\n'
  printf 'After merge, linked tasks are automatically marked completed.\n\n'
  printf 'Requires: gh CLI authenticated\n'
}
