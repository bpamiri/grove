# Tree Rescan & Remove Commands

**Issue:** #107
**Date:** 2026-03-31

## Problem

Trees added before the GitHub remote detection fix (#105) have `github: null` and no way to update them without manually editing the DB. There's also no way to unregister a tree from Grove.

## Commands

### `grove tree rescan <name>`

Re-detects GitHub remote and updates the tree record.

**CLI:** Resolves tree name, calls `POST /api/trees/:id/rescan`, displays updated fields.

**API: `POST /api/trees/:id/rescan`**

1. Lookup tree by ID in DB — 404 if not found
2. Call `detectGithubRemote(tree.path)` to re-read the git remote
3. Call `db.treeUpsert()` to update the `github` field
4. Update YAML config via `configSet()`
5. Emit event via `db.addEvent()`
6. Return updated tree (200)

**Output:**
```
✔ Rescanned grove
  github: bpamiri/grove (was: null)
```

### `grove tree remove <name> [--force]`

Removes a tree from Grove. Does not delete the repo on disk.

**CLI:** Resolves tree name, calls `DELETE /api/trees/:id?force=true|false`, displays result.

**API: `DELETE /api/trees/:id`**

1. Lookup tree by ID — 404 if not found
2. Check `db.tasksByTree(id)` for existing tasks
3. If tasks exist and `force` query param is not `true` — return 409 with task count
4. If force or no tasks: delete tasks (if any), delete tree from DB, remove from YAML config
5. Emit event via `db.addEvent()`
6. Return 200 with deleted tree info and task count

**CLI on 409 (blocked):**
```
✘ Tree "grove" has 12 tasks. Use --force to remove the tree and all its tasks.
```

**CLI on success:**
```
✔ Removed tree "grove" (12 tasks deleted)
```

## DB Changes

Add to `src/broker/db.ts`:

- `treeDelete(id: string): void` — `DELETE FROM trees WHERE id = ?`
- `taskDeleteByTree(treeId: string): number` — `DELETE FROM tasks WHERE tree_id = ?`, returns count of deleted rows

## Layers Modified

| Layer | File | Changes |
|-------|------|---------|
| DB | `src/broker/db.ts` | Add `treeDelete()`, `taskDeleteByTree()` |
| API | `src/broker/server.ts` | Add `POST /api/trees/:id/rescan`, `DELETE /api/trees/:id` |
| CLI | `src/cli/commands/trees.ts` | Add `rescan` and `remove` subcommands |
| Help | `src/cli/commands/help.ts` | Add help entries for new commands |

## Deletion Behavior

- **Default:** Block removal if the tree has any tasks. Return 409 with task count.
- **`--force`:** Cascade delete all tasks for the tree, then delete the tree.
- Tasks are deleted via `taskDeleteByTree()` before `treeDelete()` to respect any FK constraints.
- The repo on disk is never touched.

## Dual-Store Consistency

Trees live in both YAML config and SQLite DB. Both commands update both stores:

- **Rescan:** Updates `github` field in DB via `treeUpsert()`, updates YAML via `configSet()`
- **Remove:** Deletes from DB via `treeDelete()`, removes from YAML via config manipulation

## Tests

- **DB unit tests** (`tests/broker/db.test.ts`): `treeDelete` (happy path), `taskDeleteByTree` (with/without tasks)
- **API tests**: rescan (200, 404), remove (200 no tasks, 409 with tasks, 200 force, 404)
- **GitHub detection**: Already covered by existing tests

## Out of Scope

- Bulk rescan (all trees) — can be added later
- Interactive confirmation prompt in CLI — using `--force` flag instead
- Deleting the git repo from disk
