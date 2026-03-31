# PR Import and Review — Design Spec

## Overview

Agent-assisted review pipeline for contributed PRs on open-source repos. PRs are imported into Grove (manually or via polling), run through a `pr-review` path that checks CI, performs deep agent review, then pauses for maintainer verdict. The maintainer acts from the Grove UI: merge, request changes, close, or defer.

## Pipeline: `pr-review`

```
ci-check (gate) → review (worker) → verdict (NEW step type)
```

### Step 1: `ci-check` (gate)

PR-aware gate that checks CI status on the contributor's PR via `gh pr checks <pr-number>`.

- **CI passes** → proceed to review
- **CI pending** → poll with existing `watchCI` pattern from merge manager
- **CI fails** → skip review, go straight to verdict with "CI failed" report (saves tokens)
- **CI timeout** → configurable (default 15 min), fails with "CI timed out", skips to verdict

### Step 2: `review` (worker)

Spawns a Claude agent that:

1. Checks out the PR branch into the worktree via `gh pr checkout <number> --detach`
2. Reads the diff against the base branch
3. Analyzes for: backwards compatibility, engine adapter coverage, test coverage, code quality, project conventions
4. Writes a structured report to `.grove/pr-review.md`

Review prompt is configurable per tree in `grove.yaml` under `pr_review.prompt`.

#### Report format

```markdown
## PR Review: #123 — <PR title>

### Verdict: Recommend Merge | Request Changes | Needs Discussion

### CI Status
- All checks passed (3/3)

### Summary
[2-3 sentence overview]

### Backwards Compatibility
[Analysis — breaking changes, migration needs]

### Test Coverage
[What's tested, what's missing]

### Code Quality
[Style, patterns, concerns]

### Engine Adapter Coverage
[Lucee/Adobe/BoxLang impact — Wheels-specific]

### Suggested Comments
[Line-level feedback, grouped by file — become PR comments on "Request Changes"]
```

### Step 3: `verdict` (new step type)

Pauses the pipeline and waits for human input. Task enters `waiting` status.

#### Step engine integration

```typescript
case "verdict": {
  db.run(
    "UPDATE tasks SET status = 'waiting', paused = 1 WHERE id = ?",
    [task.id]
  );
  db.addEvent(task.id, null, "verdict_waiting", "Awaiting maintainer decision");
  bus.emit("task:status", { taskId: task.id, status: "waiting" });
  // Pipeline paused — no onStepComplete call until human acts
  break;
}
```

#### Verdict API

```
POST /api/tasks/:id/verdict
Body: { action: "merge" | "request_changes" | "close" | "defer", comment?: string }
```

- **merge** → `gh pr merge`, then `onStepComplete(taskId, "success")`
- **request_changes** → post review comment via `gh pr review --request-changes --body <comment>`, set status to `deferred`
- **close** → `gh pr close --comment <comment>`, then `onStepComplete(taskId, "success")`
- **defer** → no-op, task stays in `waiting`

#### Reusability

The `verdict` step type is a general-purpose human decision point. Any path can include it wherever approval is needed — not just PR review.

## PR Import

### Auto-import (polling)

A poller runs on configurable interval for trees with `pr_review.enabled: true`. Calls `gh pr list`, filters out PRs where the branch matches the tree's `branch_prefix` (e.g., `grove/` — these are Grove-created PRs), and creates draft tasks for new ones.

### Manual import

- **API:** `POST /api/trees/:id/import-prs` (mirrors existing `import-issues` pattern)
- **CLI:** `grove pr import <tree> [pr-number]`
- **GUI:** "Import PRs" button in Settings page alongside existing "Import Issues"

### Task creation from PR

- `title` — PR title
- `description` — PR body
- `source_pr` — PR number (new column)
- `path_name` — `pr-review`
- `tree_id` — from the tree config

### Filtering Grove PRs

Skip PRs where the head branch starts with the tree's `branch_prefix` (default `grove/`). These are Grove-created PRs from dev tasks and should not be re-imported as review tasks.

### Configuration

```yaml
trees:
  wheels:
    path: ~/GitHub/wheels-dev/wheels
    github: wheels-dev/wheels
    default_path: development
    pr_review:
      enabled: true
      poll_interval: 300      # seconds, default 5min
      auto_dispatch: false    # create as draft, don't auto-start review
      prompt: |               # optional custom review prompt
        Review this PR for backwards compatibility, engine adapter
        coverage (Lucee, Adobe, BoxLang), and test coverage.
```

## Worktree and Checkout

PR review tasks reuse the existing worktree system. Worktree created at `.grove/worktrees/{task_id}/`.

- **Checkout:** `gh pr checkout <pr-number> --detach` (avoids local tracking branch conflicts, handles fork PRs natively)
- **Read-only:** Review worker analyzes but does not modify code
- **No push from worktree:** Merge action in verdict calls `gh pr merge` on the original PR, not push from worktree
- **Cleanup:** Worktree removed on terminal state (`completed`, `failed`). Deferred tasks keep worktree for re-review.

## Data Model

### New column on `tasks` table

- `source_pr INTEGER` — contributed PR number being reviewed (distinct from `pr_number` which is the PR Grove creates for dev tasks)

### New statuses

- **`waiting`** — verdict step reached, awaiting human decision
  - Transitions: `active` → `waiting` (verdict step entered)
  - From waiting: → `completed` (merge or close), → `deferred` (request changes)
- **`deferred`** — maintainer requested changes, contributor needs to update
  - Transitions: `waiting` → `deferred` (request changes action)
  - From deferred: → `queued` (re-dispatch for re-review after contributor pushes)

### No new tables

- Review report: file in worktree (`.grove/pr-review.md`), cached in `session_summary`
- Verdict actions: logged as events in existing `events` table
- PR metadata: stored on the task via `source_pr` column

## UI Changes

### Task list

- PR review tasks show a PR badge/icon next to task ID
- `waiting` tasks visible under "Active" filter (they need attention)

### Task detail for `waiting` status

- **Top:** PR metadata — number, author, branch, CI status, commit SHA reviewed
- **Middle:** Rendered review report from `.grove/pr-review.md`
- **Bottom:** Four action buttons:
  - Merge (green) — merges the PR
  - Request Changes (amber) — expands editable text area pre-populated with agent's suggested comments, posts as PR review
  - Close (red) — closes PR with comment
  - Defer (gray) — no action, come back later

### Settings page

- "Import PRs" button per tree (next to "Import Issues")
- PR review config: toggle auto-import, poll interval, auto-dispatch

## Error Handling

| Scenario | Behavior |
|----------|----------|
| PR closed externally | CI check or verdict detects via `gh pr view`, auto-completes task with "PR closed externally" event |
| PR updated during review | Review is stale but not harmful. Verdict UI shows commit SHA. Re-dispatch for fresh review. |
| CI never completes | Timeout (default 15 min), skip to verdict with "CI timed out" context |
| Fork PRs | `gh pr checkout` handles forks natively, no special handling |
| Merge conflicts | `gh pr merge` fails, verdict reports "PR has merge conflicts — contributor needs to rebase", task deferred |
| Re-review after update | Poller detects new commit SHA on deferred PR, logs event and sets status back to `draft`. Maintainer dispatches manually (or auto-dispatch if configured). |

## Open Questions (resolved)

- **Agent-powered vs heuristic review?** Agent-powered — the review worker spawns Claude.
- **Output format?** Internal report in Grove, with optional publish to PR.
- **Import mechanism?** Both auto (polling) and manual (API/CLI/GUI).
- **Verdict actions?** Merge, request changes, close, defer.
- **CI-first?** Yes — gate checks CI before spawning review agent.
