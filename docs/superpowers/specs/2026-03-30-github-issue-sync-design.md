# Design: Auto-Create GitHub Issues on Task Creation

**Task:** W-029 | **Issue:** #57 | **Date:** 2026-03-30

## Problem

Tasks created in Grove (GUI, orchestrator, API) have no corresponding GitHub issue.
This means `github_issue` is NULL, auto-close on merge doesn't fire, and work isn't
visible in GitHub's issue tracker.

## Solution

Listen for `task:created` events on the bus. When a task has a `tree_id` pointing to
a tree with `github` configured, call `gh issue create` and store the issue number.

## Architecture

### New function: `ghIssueCreate()` in `src/merge/github.ts`

```typescript
export function ghIssueCreate(repo: string, opts: {
  title: string;
  body: string;
}): { number: number; url: string }
```

Calls `gh issue create -R <repo> --title <title> --body <body>`, parses the returned
URL for the issue number.

### New module: `src/broker/github-sync.ts`

Exports `wireGitHubSync(db: Database): void`, called from broker startup.

Listens to `bus.on("task:created")` and:
1. Skips if `task.github_issue` is already set (imported issues)
2. Skips if `task.tree_id` is null (no tree yet)
3. Looks up tree — skips if `tree.github` is null
4. Calls `ghIssueCreate(tree.github, { title, body })`
5. Updates `tasks.github_issue = issueNumber`
6. Logs `issue_created` event
7. On failure: logs `issue_create_failed` event (non-fatal)

### Deferred creation at dispatch

For tasks created without a `tree_id`, issue creation is attempted at dispatch time
(`POST /api/tasks/:id/dispatch`). Before promoting to `queued`, if `github_issue` is
null and tree has `github`, create the issue.

### Issue body format

```
## {task.title}

{task.description || "No description provided."}

**Task:** {task.id}
**Path:** {task.path_name}

*Created by [Grove](https://grove.cloud)*
```

## Event types

Add to `EventType` enum:
- `IssueCreated = "issue_created"`
- `IssueCreateFailed = "issue_create_failed"`

## Files to modify

| File | Change |
|------|--------|
| `src/merge/github.ts` | Add `ghIssueCreate()` |
| `src/broker/github-sync.ts` | New — event listener module |
| `src/broker/index.ts` | Wire `wireGitHubSync(db)` at startup |
| `src/broker/server.ts` | Add deferred issue creation at dispatch |
| `src/shared/types.ts` | Add event type enums |
| `tests/merge/github.test.ts` | Test `ghIssueCreate()` |
| `tests/broker/github-sync.test.ts` | New — test the event handler |

## Non-goals

- No backfill of existing tasks
- No settings toggle (gated on `tree.github` being non-null)
- No label assignment on created issues
