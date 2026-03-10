#!/usr/bin/env bash
# lib/prompt.sh — Worker prompt generation
# Builds the system prompt sent to Claude Code worker sessions.

# ---------------------------------------------------------------------------
# grove_prompt_slugify TEXT
# Convert text to URL-safe slug for branch names.
# Lowercase, alphanumeric + hyphens, no leading/trailing/double hyphens, max 50 chars.
# ---------------------------------------------------------------------------
grove_prompt_slugify() {
  local text="$1"
  python3 -c "
import sys, re
text = sys.argv[1].lower().strip()
text = re.sub(r'[^a-z0-9]+', '-', text)
text = text.strip('-')
text = re.sub(r'-{2,}', '-', text)
print(text[:50].rstrip('-'))
" "$text"
}

# ---------------------------------------------------------------------------
# grove_prompt_build TASK_ID
# Build the complete prompt for a new worker session. Output to stdout.
# ---------------------------------------------------------------------------
grove_prompt_build() {
  local task_id="$1"

  local title repo description source_type source_ref strategy
  local strategy_config session_summary branch

  title=$(grove_db_task_get "$task_id" "title")
  repo=$(grove_db_task_get "$task_id" "repo")
  description=$(grove_db_task_get "$task_id" "description")
  source_type=$(grove_db_task_get "$task_id" "source_type")
  source_ref=$(grove_db_task_get "$task_id" "source_ref")
  strategy=$(grove_db_task_get "$task_id" "strategy")
  strategy_config=$(grove_db_task_get "$task_id" "strategy_config")
  session_summary=$(grove_db_task_get "$task_id" "session_summary")
  branch=$(grove_db_task_get "$task_id" "branch")

  # Determine branch name if not yet set
  if [ -z "$branch" ]; then
    local slug
    slug=$(grove_prompt_slugify "$title")
    local branch_prefix
    branch_prefix=$(grove_db_get "SELECT COALESCE(branch_prefix, 'grove/') FROM repos WHERE name = '$(grove_db_escape "$repo")';" 2>/dev/null)
    if [ -z "$branch_prefix" ]; then
      branch_prefix="grove/"
    fi
    branch="${branch_prefix}${task_id}-${slug}"
  fi

  # Look for CLAUDE.md in the repo
  local repo_path claude_md_content
  repo_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo")';")
  claude_md_content=""
  if [ -n "$repo_path" ] && [ -f "$repo_path/CLAUDE.md" ]; then
    claude_md_content=$(cat "$repo_path/CLAUDE.md" 2>/dev/null || true)
  fi

  # GitHub URL for source reference
  local source_info=""
  if [ -n "$source_ref" ]; then
    case "$source_type" in
      github_issue)
        source_info="GitHub Issue: $source_ref"
        ;;
      github_pr)
        source_info="GitHub PR: $source_ref"
        ;;
      *)
        source_info="Source: $source_ref"
        ;;
    esac
  fi

  # Strategy instructions
  local strategy_instructions=""
  case "${strategy:-solo}" in
    solo)
      strategy_instructions="You are the sole worker on this task. Complete it end-to-end: implement, test, and commit."
      ;;
    team)
      strategy_instructions="You are one worker in a team. Focus only on your assigned scope. Do not modify files outside your area. Coordinate via commit messages."
      if [ -n "$strategy_config" ]; then
        strategy_instructions="$strategy_instructions
Scope: $strategy_config"
      fi
      ;;
    sweep)
      strategy_instructions="This is a sweep task — apply the same change across multiple files or modules. Be thorough and consistent. Check every occurrence."
      if [ -n "$strategy_config" ]; then
        strategy_instructions="$strategy_instructions
Pattern: $strategy_config"
      fi
      ;;
  esac

  # Build the prompt
  cat <<PROMPT
# Task: $task_id
## $title

${description:+### Description
$description
}
${source_info:+### Source
$source_info
}
### Strategy
$strategy_instructions

### Git Branch
Work on branch: \`$branch\`
Commit message format: \`grove($task_id): description of change\`

${claude_md_content:+### Repository Context (from CLAUDE.md)
$claude_md_content
}
${session_summary:+### Previous Session
$session_summary
}
### Session Summary Instructions
Before finishing your session, create a file at \`.grove/session-summary.md\` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains to be done (if anything)
- **Blockers**: Any issues encountered

This file is read by Grove to maintain continuity across sessions.

### Working Guidelines
- Create a new git branch if it doesn't exist: \`$branch\`
- Make atomic commits with the format: \`grove($task_id): description\`
- Run tests if available before marking done
- Write the session summary file before finishing
PROMPT
}

# ---------------------------------------------------------------------------
# grove_prompt_resume TASK_ID
# Build a resume-specific prompt that includes previous session context.
# ---------------------------------------------------------------------------
grove_prompt_resume() {
  local task_id="$1"

  local title repo session_summary files_modified next_steps branch

  title=$(grove_db_task_get "$task_id" "title")
  repo=$(grove_db_task_get "$task_id" "repo")
  session_summary=$(grove_db_task_get "$task_id" "session_summary")
  files_modified=$(grove_db_task_get "$task_id" "files_modified")
  next_steps=$(grove_db_task_get "$task_id" "next_steps")
  branch=$(grove_db_task_get "$task_id" "branch")

  # Look for CLAUDE.md in the repo
  local repo_path claude_md_content
  repo_path=$(grove_db_get "SELECT local_path FROM repos WHERE name = '$(grove_db_escape "$repo")';")
  claude_md_content=""
  if [ -n "$repo_path" ] && [ -f "$repo_path/CLAUDE.md" ]; then
    claude_md_content=$(cat "$repo_path/CLAUDE.md" 2>/dev/null || true)
  fi

  cat <<PROMPT
# Resuming Task: $task_id
## $title

You are resuming a previously paused task. Continue from where the last session left off.

### Previous Session Summary
${session_summary:-No previous session summary available.}

### Files Already Modified
${files_modified:-No files recorded from previous session.}

### Next Steps
${next_steps:-No specific next steps recorded. Review the code and continue the task.}

### Git Branch
Continue on branch: \`${branch:-unknown}\`
Commit message format: \`grove($task_id): description of change\`

${claude_md_content:+### Repository Context (from CLAUDE.md)
$claude_md_content
}
### Session Summary Instructions
Before finishing your session, create or update \`.grove/session-summary.md\` in the worktree with:
- **Summary**: What you accomplished (including previous + this session)
- **Files Modified**: List of all files changed across sessions
- **Next Steps**: What remains to be done (if anything)
- **Blockers**: Any issues encountered

### Working Guidelines
- You should already be on branch: \`${branch:-unknown}\`
- Make atomic commits with the format: \`grove($task_id): description\`
- Run tests if available before marking done
- Write the session summary file before finishing
PROMPT
}
