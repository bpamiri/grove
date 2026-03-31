# GitHub Integration

Grove integrates with GitHub for issue tracking, pull request management, and CI monitoring. All GitHub operations use the `gh` CLI under the hood.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- Trees configured with a `github` field (e.g., `github: myorg/api-server`)

---

## Issue Sync

### Auto-Create Issues

When a task is created for a tree that has a GitHub repo configured, Grove automatically creates a matching GitHub issue. The issue includes:

- The task title as the issue title
- The task description as the issue body
- Task metadata (ID, path) in a footer

The issue number is stored on the task as `github_issue`. This link is used later for auto-closing when the task's PR merges.

If issue creation fails (e.g., network error, permissions), the failure is logged as an event but doesn't block the task.

> **Note:** Issue creation only fires on `task:created`. Tasks created without a tree assignment (e.g., via `grove task add` without a tree) will not get a GitHub issue, even if a tree is assigned later. To ensure issue tracking, assign a tree when creating the task.

### Import Issues as Tasks

You can import open GitHub issues as draft tasks:

**Web GUI:** When creating a new task, select a tree — the dropdown auto-loads open issues from that tree's GitHub repo. Select an issue to pre-fill the task title and description.

**API:**

```
GET  /api/trees/:id/issues          # Fetch open issues
POST /api/trees/:id/import-issues   # Create tasks from all open issues
```

The import endpoint fetches up to 50 open issues (sorted ascending by number), skips any that already have a matching task in the database, and creates the rest as draft tasks with `path_name: "development"`. Task titles include the issue number (e.g., "Add auth middleware Issue #42") for traceability.

Imported tasks have `github_issue` set immediately, so the auto-create listener skips them — preventing duplicate issue creation.

### Auto-Close Issues

When a task's PR is merged, the merge manager automatically closes the linked GitHub issue via `gh issue close`. This only happens if the task has a `github_issue` number set.

The PR body also includes `Closes #N` syntax, so GitHub's native issue-linking works as a fallback.

---

## How Sync Works Internally

The GitHub sync module (`src/broker/github-sync.ts`) is wired at broker startup via `wireGitHubSync()`. It registers a single event listener on the `task:created` bus event.

### Issue Creation Flow

```
task:created event
  │
  ├─ Task has no tree_id? → skip
  ├─ Tree has no github field? → skip
  ├─ Task already has github_issue? → skip (imported task)
  │
  └─ gh issue create -R org/repo --title ... --body ...
       │
       ├─ Success → parse issue URL for number → update task row
       └─ Failure → log issue_create_failed event → continue
```

All GitHub operations use the `gh` CLI (`src/merge/github.ts`). Issue creation is fire-and-forget — errors never propagate to the caller or block task processing.

---

## Pull Request Lifecycle

The merge manager handles the full PR lifecycle. No manual `git push` or PR creation needed.

### Branch Push

After a worker commits changes and gates pass, the merge manager pushes the task's branch:

```
git push -u origin grove/W-042-add-auth-middleware
```

Branch naming convention: `{branch_prefix}{task_id}-{slugified-title}`

### PR Creation

The merge manager creates a PR with:

| Section | Content |
|---------|---------|
| **Title** | `feat: (TASK-ID) description` (max 60 chars) |
| **Description** | Task description |
| **Metadata** | Task ID, path name, cost, file count |
| **Gate results** | Per-gate pass/fail status with messages |
| **Issue link** | `Closes #N` if `github_issue` is set |
| **Footer** | Grove attribution |

If the task already has a PR (from a previous attempt), the merge manager reuses it — updating the title and re-checking CI rather than creating a duplicate.

### CI Monitoring

After PR creation, Grove polls GitHub CI checks every 15 seconds for up to 10 minutes:

```
Pending ──▶ All checks pass ──▶ Auto-merge
                │
                └──▶ Any check fails ──▶ Feed failure back to worker
```

**On CI success:** The PR is merged with `--merge` strategy. The linked issue is closed. The worktree and branches are cleaned up.

**On CI failure:** Grove fetches the failing check details (name, conclusion, link) and appends them to the task's session summary. The step engine receives a `failure` outcome, which triggers a retry — the worker gets the CI failure context and can fix the issue.

**On timeout:** Treated as a failure after 10 minutes of polling.

### Conflict Handling

The evaluator performs a pre-gate rebase before running quality checks:

1. Fetch latest from origin
2. Compare merge-base against remote HEAD
3. Rebase task branch onto the base ref
4. If rebase conflicts: abort and count as a failure

After 3 consecutive rebase failures (`MAX_REBASE_FAILURES`), the failure escalates to `fatal` — the task stops retrying and surfaces the conflict for manual resolution.

---

## Merge Queue

Merges are processed **sequentially per tree** to prevent race conditions. If tasks A and B both pass gates for the same tree, B waits for A's PR to merge before pushing.

```
Tree: api-server
  Queue: [Task A (merging)] → [Task B (waiting)] → [Task C (waiting)]
```

Different trees merge independently in parallel.

---

## Configuration

GitHub integration requires minimal configuration:

```yaml
trees:
  api-server:
    path: ~/code/api-server
    github: myorg/api-server       # Required for all GitHub features
    default_branch: main            # Base branch for PRs (auto-detected if omitted)
    branch_prefix: grove/           # Branch naming prefix
```

The `github` field is set automatically by `grove tree add` if the repo has a GitHub remote. You can override it manually for repos with multiple remotes.
