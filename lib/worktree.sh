#!/usr/bin/env bash
# lib/worktree.sh — Git worktree management for Grove tasks
# Each task gets an isolated worktree under {repo}/.grove/worktrees/{task-id}

# ---------------------------------------------------------------------------
# grove_worktree_create TASK_ID REPO_NAME
# Create a git worktree for the task. Prints the worktree path to stdout.
# Sets the task's branch and worktree_path fields in the DB.
# ---------------------------------------------------------------------------
grove_worktree_create() {
  local task_id="$1"
  local repo_name="$2"

  # Get repo local path
  local repo_path
  repo_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")
  if [ -z "$repo_path" ]; then
    grove_die "Repo '$repo_name' not found in database."
  fi

  # Expand ~ in path
  case "$repo_path" in "~/"*) repo_path="$HOME/${repo_path#\~/}" ;; "~") repo_path="$HOME" ;; esac

  if [ ! -d "$repo_path/.git" ] && [ ! -f "$repo_path/.git" ]; then
    grove_die "Not a git repository: $repo_path"
  fi

  # Build branch name
  local title
  title=$(grove_db_task_get "$task_id" "title")
  local slug
  slug=$(grove_prompt_slugify "$title")
  local branch_prefix
  branch_prefix=$(grove_db_get "SELECT COALESCE(branch_prefix, 'grove/') FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")
  if [ -z "$branch_prefix" ]; then
    branch_prefix="grove/"
  fi
  local branch="${branch_prefix}${task_id}-${slug}"

  # Worktree destination
  local worktree_dir="$repo_path/.grove/worktrees"
  local worktree_path="$worktree_dir/$task_id"

  # Create parent directory
  mkdir -p "$worktree_dir"

  # If worktree already exists, return it
  if [ -d "$worktree_path" ]; then
    grove_debug "Worktree already exists: $worktree_path"
    grove_db_task_set "$task_id" "branch" "$branch"
    grove_db_task_set "$task_id" "worktree_path" "$worktree_path"
    printf '%s' "$worktree_path"
    return 0
  fi

  # Check if branch already exists (local or remote)
  local branch_exists=0
  if git -C "$repo_path" rev-parse --verify "$branch" >/dev/null 2>&1; then
    branch_exists=1
  fi

  # Create the worktree (|| true prevents set -e from exiting on failure)
  local rc=0
  if [ "$branch_exists" = "1" ]; then
    git -C "$repo_path" worktree add "$worktree_path" "$branch" >/dev/null 2>&1 || rc=$?
  else
    git -C "$repo_path" worktree add -b "$branch" "$worktree_path" >/dev/null 2>&1 || rc=$?
  fi

  if [ "$rc" -ne 0 ]; then
    grove_die "Failed to create worktree at $worktree_path (exit $rc)"
  fi

  # Create .grove directory in worktree for session artifacts
  mkdir -p "$worktree_path/.grove"

  # Update task in DB
  grove_db_task_set "$task_id" "branch" "$branch"
  grove_db_task_set "$task_id" "worktree_path" "$worktree_path"

  grove_debug "Worktree created: $worktree_path (branch: $branch)"
  printf '%s' "$worktree_path"
}

# ---------------------------------------------------------------------------
# grove_worktree_exists TASK_ID
# Check if a worktree exists for the task. Returns 0 if yes, 1 if no.
# ---------------------------------------------------------------------------
grove_worktree_exists() {
  local task_id="$1"
  local wt_path
  wt_path=$(grove_db_task_get "$task_id" "worktree_path")

  if [ -z "$wt_path" ]; then
    return 1
  fi

  if [ -d "$wt_path" ]; then
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# grove_worktree_path TASK_ID
# Return the worktree path from the DB. Empty string if not set.
# ---------------------------------------------------------------------------
grove_worktree_path() {
  local task_id="$1"
  grove_db_task_get "$task_id" "worktree_path"
}

# ---------------------------------------------------------------------------
# grove_worktree_cleanup TASK_ID
# Remove the worktree and prune. Does NOT delete the branch.
# ---------------------------------------------------------------------------
grove_worktree_cleanup() {
  local task_id="$1"

  local wt_path repo_name repo_path
  wt_path=$(grove_db_task_get "$task_id" "worktree_path")
  repo_name=$(grove_db_task_get "$task_id" "repo")

  if [ -z "$wt_path" ] || [ ! -d "$wt_path" ]; then
    grove_debug "No worktree to clean up for $task_id"
    return 0
  fi

  repo_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")
  if [ -z "$repo_path" ]; then
    grove_warn "Repo path not found for $repo_name, removing directory only"
    rm -rf "$wt_path"
    return 0
  fi

  case "$repo_path" in "~/"*) repo_path="$HOME/${repo_path#\~/}" ;; "~") repo_path="$HOME" ;; esac

  # Remove the worktree via git
  git -C "$repo_path" worktree remove "$wt_path" --force 2>/dev/null || true

  # Prune stale worktree refs
  git -C "$repo_path" worktree prune 2>/dev/null || true

  # Clear from DB
  grove_db_task_set "$task_id" "worktree_path" ""

  grove_debug "Worktree cleaned up for $task_id"
}

# ---------------------------------------------------------------------------
# grove_worktree_list REPO_NAME
# List all grove worktrees for a repo. Tab-separated: task_id, branch, path.
# ---------------------------------------------------------------------------
grove_worktree_list() {
  local repo_name="$1"

  local repo_path
  repo_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo_name")';")
  if [ -z "$repo_path" ]; then
    grove_die "Repo '$repo_name' not found in database."
  fi

  case "$repo_path" in "~/"*) repo_path="$HOME/${repo_path#\~/}" ;; "~") repo_path="$HOME" ;; esac

  if [ ! -d "$repo_path/.git" ] && [ ! -f "$repo_path/.git" ]; then
    grove_die "Not a git repository: $repo_path"
  fi

  # Resolve to real path for consistent comparison (handles macOS /private symlink)
  local resolved_repo_path
  resolved_repo_path=$(cd "$repo_path" && pwd -P)

  # List worktrees and filter to grove ones
  local wt_output
  wt_output=$(git -C "$repo_path" worktree list --porcelain 2>/dev/null || true)

  if [ -z "$wt_output" ]; then
    return 0
  fi

  # Parse porcelain output using heredoc (not pipe) to avoid subshell
  local current_path="" current_branch=""
  local grove_dir="$resolved_repo_path/.grove/worktrees"
  local line wt_task_id
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "worktree "*)
        current_path="${line#worktree }"
        current_branch=""
        ;;
      "branch "*)
        current_branch="${line#branch refs/heads/}"
        ;;
      "")
        # End of a worktree entry — check if it's a grove worktree
        if [ -n "$current_path" ] && [ -n "$current_branch" ]; then
          case "$current_path" in
            "$grove_dir"/*)
              wt_task_id=$(basename "$current_path")
              printf '%s\t%s\t%s\n' "$wt_task_id" "$current_branch" "$current_path"
              ;;
          esac
        fi
        current_path=""
        current_branch=""
        ;;
    esac
  done <<EOF
$wt_output
EOF

  # Flush the last entry (porcelain output may not end with a blank line)
  if [ -n "$current_path" ] && [ -n "$current_branch" ]; then
    case "$current_path" in
      "$grove_dir"/*)
        wt_task_id=$(basename "$current_path")
        printf '%s\t%s\t%s\n' "$wt_task_id" "$current_branch" "$current_path"
        ;;
    esac
  fi
}
