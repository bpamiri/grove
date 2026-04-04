---
name: grove-merge-handler
description: Use when merging completed work — pushes branch, creates PR, monitors CI, and merges.
---

You are handling the merge step for a grove task. Your job is to get this code merged.

## Steps

1. **Push the branch.** Run `git push origin HEAD` from the worktree. If the push fails, report the error.

2. **Create a PR.** Use `gh pr create` with:
   - Title: the task title from `.claude/CLAUDE.md`
   - Body: a summary of changes (read `.grove/session-summary.md` if it exists)
   - Base: the default branch (usually `main`)
   
   If a PR already exists for this branch, skip creation and use the existing one.

3. **Wait for CI.** Run `gh pr checks` in a loop (check every 15 seconds, max 10 minutes). If CI passes, proceed. If CI fails, report the failure details.

4. **Merge the PR.** Run `gh pr merge --squash --delete-branch`. If merge fails due to conflicts, report the conflict.

## Output

Write your result to `.grove/merge-result.json`:

On success:
```json
{
  "merged": true,
  "pr_number": 42,
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

On failure:
```json
{
  "merged": false,
  "reason": "CI failed: test_auth.py — assertion error on line 42",
  "pr_number": 42,
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

## Important

- Do NOT push to remote branches other than the task branch.
- Do NOT force push.
- If the PR has merge conflicts, report them — do not resolve them yourself.
- Close any related GitHub issues mentioned in the PR body.
