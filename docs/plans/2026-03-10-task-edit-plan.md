# Task Edit (`grove edit`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `grove edit` command that modifies task fields after creation, with both CLI flags and interactive mode.

**Architecture:** New command file `src/commands/edit.ts` following the dual-mode pattern from `add.ts` (flags for quick edits, interactive when no flags). Circular dependency detection via DFS walk using existing `db.taskGet()`. Registered in `src/index.ts` lazy loader and help listing.

**Tech Stack:** TypeScript, bun:sqlite (via existing Database class), @clack/prompts (via existing `src/core/prompts.ts` wrappers), bun:test

---

### Task 1: Write edit command tests

**Files:**
- Create: `tests/commands/edit.test.ts`

**Step 1: Create test file with setup/teardown matching add.test.ts pattern**

The test file follows the exact same setup/teardown pattern as `tests/commands/add.test.ts`:
- Temp directory with grove.db and grove.yaml
- Database init with schema.sql
- Repo upserts for FK constraints
- resetModules() to clear singletons
- insertTask() helper for creating test tasks

17 tests covering:
- Edit title, description, priority, repo, depends_on, max_retries, strategy via flags
- Edit multiple fields at once
- Status gate: block done, failed; allow paused
- Dependency validation: nonexistent ID rejected
- Circular dependency: direct (A->B->A) and deep (A->B->C->A) cycles rejected
- Clear depends_on with empty string
- --no-retry sets max_retries to 0
- Invalid strategy/repo rejected
- Event logging with changed field names
- Nonexistent task ID errors

**Step 2: Run tests to verify they fail (command doesn't exist yet)**

Run: `bun test tests/commands/edit.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/edit`

**Step 3: Commit test file**

Commit message: `test: add edit command tests (17 tests, all failing)`

---

### Task 2: Implement the edit command (flag mode + interactive)

**Files:**
- Create: `src/commands/edit.ts`

**Step 1: Create the edit command**

The command exports `editCommand: Command` with:

**Constants:**
- `TERMINAL_STATUSES = new Set(["done", "completed", "failed"])` — status gate
- `VALID_STRATEGIES = new Set(Object.values(Strategy))` — for validation

**`hasCycle(db, taskId, newDeps): boolean`** — DFS cycle detection:
- Takes the task being edited and its proposed new dependency IDs
- Walks each dependency's chain via `db.taskGet()` + `depends_on.split(",")`
- Returns true if `taskId` is found in any chain (cycle)
- Uses a `visited` Set to avoid re-walking

**`run(args)`** flow:
1. Parse first arg as taskId
2. Fetch task, check status gate (die if terminal)
3. Parse remaining args as `--flag value` or `--flag=value` pairs
4. If no flags → call `interactiveEdit()`
5. Otherwise → call `applyChanges()`

**Flag parsing** (matches add.ts pattern):
- `--title TEXT` / `--title=TEXT`
- `--description TEXT` / `--description=TEXT`
- `--repo NAME` / `--repo=NAME`
- `--priority N` / `--priority=N`
- `--depends IDS` / `--depends=IDS`
- `--max-retries N` / `--max-retries=N`
- `--no-retry` (sets max_retries to "0")
- `--strategy NAME` / `--strategy=NAME`

**`applyChanges(db, task, changes)`** — validates and applies:
- title: non-empty check
- description: allow empty (sets null)
- repo: must be in `configRepos()`
- priority: positive integer parse
- depends_on: validate all IDs exist, check hasCycle, empty string → null
- max_retries: non-negative integer parse
- strategy: must be in VALID_STRATEGIES
- Logs one event: `"Edited: field1, field2"`

**`interactiveEdit(db, task)`**:
- Display all 7 fields with current values + "Done" option
- `numberedMenu()` for field selection (8 options: 7 fields + Done)
- Per-field prompts: `text()` for strings/numbers, `choose()` for repo/strategy
- max_retries special case: empty input → set to null (global default)
- Loop until "Done" selected
- Refresh task from DB after each change

**Step 2: Run tests**

Run: `bun test tests/commands/edit.test.ts`
Expected: All 17 tests PASS

**Step 3: Commit**

Commit message: `feat: add grove edit command with flag and interactive modes`

---

### Task 3: Register edit command in index.ts and help.ts

**Files:**
- Modify: `src/index.ts:21-51` (add `case "edit"` to `loadCommand`)
- Modify: `src/index.ts:63-71` (add `"edit"` to `allCommandNames`)
- Modify: `src/commands/help.ts:38-44` (add edit to Task Management section)

**Step 1: Add edit to loadCommand switch**

In `src/index.ts`, inside the `loadCommand` function's switch statement, add after the `"tasks"` case (around line 25):

```typescript
    case "edit": return (await import("./commands/edit")).editCommand;
```

**Step 2: Add edit to allCommandNames**

In `src/index.ts`, add `"edit"` to the `allCommandNames` array, in the task management group after `"tasks"`:

```typescript
  "add", "tasks", "edit", "plan", "prioritize", "sync",
```

**Step 3: Add edit to help listing**

In `src/commands/help.ts`, in the "Task Management" section, add after the `grove add` line:

```typescript
        "grove edit ID      Edit task fields (title, priority, etc.)",
```

**Step 4: Run full test suite**

Run: `bun test`
Expected: All tests pass (existing 247 + 17 new = 264)

**Step 5: Commit**

Commit message: `feat: register grove edit in command router and help listing`

---

### Task 4: Verify build and manual test

**Step 1: Build the binary**

Run: `bun build src/index.ts --compile --outfile bin/grove`
Expected: Compiles successfully

**Step 2: Verify help output**

Run: `bin/grove help edit`
Expected: Shows the edit command help text with all flags and examples

**Step 3: Verify edit appears in main help**

Run: `bin/grove help | grep edit`
Expected: Shows `grove edit ID      Edit task fields (title, priority, etc.)`

**Step 4: Run full test suite one more time**

Run: `bun test`
Expected: All tests pass

**Step 5: Commit (if any fixes needed)**

Only commit if fixes were required in steps 1-4.

---

## Files Summary

| File | Change |
|------|--------|
| `tests/commands/edit.test.ts` | **NEW** — 17 tests covering all validation and flag modes |
| `src/commands/edit.ts` | **NEW** — edit command with flag parsing, validation, interactive mode, cycle detection |
| `src/index.ts` | **MODIFY** — add `case "edit"` to loadCommand, add to allCommandNames |
| `src/commands/help.ts` | **MODIFY** — add edit to Task Management section |

## Key Patterns to Follow

- **Arg parsing:** Match `add.ts` pattern — `--flag value` and `--flag=value` forms
- **Validation errors:** Use `ui.die()` for all validation failures (matches all other commands)
- **DB updates:** Use existing `db.taskSet(id, field, value)` — already handles `updated_at`
- **Events:** Use `db.addEvent()` with `EventType.StatusChange`
- **Interactive prompts:** Use wrappers from `src/core/prompts.ts` — `text()`, `choose()`, `numberedMenu()`
- **Test setup:** Match `add.test.ts` — temp dir, Database init, repo upsert, config YAML, resetModules, isTTY override for non-interactive
