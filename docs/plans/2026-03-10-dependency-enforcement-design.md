# Dependency Enforcement Design

## Goal

Prevent dispatch of tasks whose dependencies haven't completed. Surface blocked/unblocked state clearly.

## Format

`depends_on` stays comma-separated task IDs (e.g. `"W-001,W-002"`). A task is **blocked** when any dep has status other than `done` or `completed`. Already parsed this way in `hud.ts`.

## Changes

### 1. `grove add --depends W-001,W-002`

New flag on the add command. Validates that referenced task IDs exist. Stores as comma-separated string in `depends_on` column.

### 2. Dispatch gate in `work.ts`

All three dispatch paths (interactive menu, single task, batch) check dependencies before dispatching. Blocked tasks excluded from candidate queries. Warning printed for each skipped task: `"Skipping W-003: blocked by W-001 (running)"`. Batch summary line includes blocked count.

The SQL candidate query adds a WHERE filter — tasks with non-null `depends_on` are post-filtered in TypeScript (since checking dep statuses requires lookups). Simpler than a correlated subquery.

### 3. Unblock notification on completion

When a task reaches `done`/`completed` in `work.ts` (both foreground and background paths), query for tasks where `depends_on` contains the completed task ID. For each newly-unblocked task (all deps now met), log a `"dependency_met"` event and print `"Unblocked: W-005 (Fix dashboard)"`.

### 4. No new files

All changes in existing files: `work.ts`, `add.ts`, `hud.ts` (minor — reuse existing blocked logic as shared helper), plus tests.

## What's NOT included

- No circular dependency detection
- No `grove dep` standalone command
- No auto-dispatch of unblocked tasks
- No topological sort for batch ordering
- No `--force` flag to override blocked state
