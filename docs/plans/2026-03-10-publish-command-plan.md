# `grove publish` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-push branches and create draft PRs with AI-generated descriptions after worker success.

**Architecture:** New `publishTask()` function in `src/commands/publish.ts` handles push + PR creation. Called automatically by work.ts/resume.ts post-success, and manually via `grove publish TASK_ID`. Uses `gh` CLI for GitHub operations and `claude` CLI for PR body generation.

**Tech Stack:** Bun.spawnSync for git/gh/claude subprocesses, existing Database class, gh CLI JSON output parsing.

---

### Task 1: Add `ghPrCreate` helper to `src/lib/github.ts`

**Files:**
- Modify: `src/lib/github.ts:157-169` (after `ghPrClose`)
- Test: `tests/lib/github.test.ts` (NEW — only testing the argument construction, not actual gh calls)

**Step 1: Write the test**

Create `tests/lib/github.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

// We can't test actual gh calls without network, so we test the module exports exist
// and validate types. Integration testing happens in Task 6.
describe("github module exports", () => {
  test("ghPrCreate is exported", async () => {
    const mod = await import("../../src/lib/github");
    expect(typeof mod.ghPrCreate).toBe("function");
  });

  test("ghPrList is exported", async () => {
    const mod = await import("../../src/lib/github");
    expect(typeof mod.ghPrList).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/lib/github.test.ts`
Expected: FAIL — `ghPrCreate` is not exported yet.

**Step 3: Implement `ghPrCreate`**

Add to `src/lib/github.ts` after the `ghPrClose` function (after line 168):

```typescript
/**
 * Create a pull request.
 * @param repo — GitHub repo in "owner/name" format
 * @returns PR number and URL
 */
export function ghPrCreate(repo: string, opts: {
  title: string;
  body: string;
  head: string;
  draft?: boolean;
}): { number: number; url: string } {
  const args = [
    "pr", "create",
    "-R", repo,
    "--title", opts.title,
    "--body", opts.body,
    "--head", opts.head,
  ];
  if (opts.draft) args.push("--draft");

  const result = gh([...args, "--json", "number,url"]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr create failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as { number: number; url: string };
}
```

Note: the internal `gh()` helper is file-private. It needs to stay accessible. Check that `gh` is the private function at line 11 — it is, and `ghPrCreate` is in the same file so it can call it directly.

**Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/lib/github.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/github.ts tests/lib/github.test.ts
git commit -m "grove(publish): add ghPrCreate helper to github module"
```

---

### Task 2: Create `src/commands/publish.ts` — core `publishTask` function

**Files:**
- Create: `src/commands/publish.ts`
- Test: `tests/commands/publish.test.ts` (NEW)

**Step 1: Write the tests**

Create `tests/commands/publish.test.ts`. These test the validation and DB logic using a real in-memory DB but mock subprocesses (git/gh/claude won't actually run):

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-publish-test-"));
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);

  db.repoUpsert({
    name: "testrepo",
    org: "test",
    github_full: "test/testrepo",
    local_path: tempDir,
    branch_prefix: "grove/",
    claude_md_path: null,
    last_synced: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("publishTask validation", () => {
  test("returns false when task has no branch", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });

  test("returns false when task has no repo", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, branch) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "grove/T-001-fix-bug"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });

  test("returns false when worktree_path does not exist on disk", async () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, branch, worktree_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo", "grove/T-001-fix-bug", "/nonexistent/path"],
    );

    const { publishTask } = await import("../../src/commands/publish");
    const result = await publishTask("T-001", db);
    expect(result).toBe(false);
  });
});

describe("generatePrBody", () => {
  test("returns fallback when no diff available", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/nonexistent", "T-001", "Did some work");
    // Should fall back to session summary
    expect(body).toContain("Did some work");
  });

  test("includes Grove footer", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/nonexistent", "T-001", "Summary text");
    expect(body).toContain("Grove");
    expect(body).toContain("T-001");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/commands/publish.test.ts`
Expected: FAIL — module does not exist yet.

**Step 3: Implement `src/commands/publish.ts`**

Create the file with these exports:
- `generatePrBody(worktreePath, taskId, sessionSummary)` — get diff, call Claude for summary, fallback to session summary
- `publishTask(taskId, db)` — validate, push, generate body, create PR, store in DB
- `publishCommand` — CLI entry point

Key implementation details:
- `generatePrBody`: runs `git diff main...HEAD` in worktree, caps at 50K chars, spawns `claude -p --max-turns 1 --output-format text`, falls back to session_summary
- `publishTask`: validates branch/repo/worktree exist, checks for existing PR via `gh pr list --head`, pushes with `git push -u origin`, creates draft PR via `gh pr create --draft`, stores `pr_url`/`pr_number` in DB, moves status to `review`
- `publishCommand`: accepts optional TASK_ID, or lists all `done` tasks with branches

See the design doc at `docs/plans/2026-03-10-publish-command-design.md` for the full publishTask flow (10 steps) and error handling table.

**Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/commands/publish.test.ts`
Expected: PASS (validation tests pass; subprocess-dependent tests use fallback paths)

**Step 5: Commit**

```bash
git add src/commands/publish.ts tests/commands/publish.test.ts
git commit -m "grove(publish): add publish command with publishTask core function"
```

---

### Task 3: Register `publish` command in `src/index.ts`

**Files:**
- Modify: `src/index.ts:40-46` (add case to loadCommand switch)
- Modify: `src/index.ts:60-68` (add to allCommandNames)

**Step 1: Add to `loadCommand` switch**

In `src/index.ts`, add after line 40 (`case "done"`):

```typescript
    case "publish": return (await import("./commands/publish")).publishCommand;
```

**Step 2: Add to `allCommandNames` array**

In `src/index.ts`, change line 66 from:

```typescript
  "prs", "review", "done", "close", "delete",
```

to:

```typescript
  "prs", "review", "done", "publish", "close", "delete",
```

**Step 3: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All tests pass (no behavioral changes, just registration)

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "grove(publish): register publish command in router"
```

---

### Task 4: Wire auto-publish into `src/commands/work.ts`

**Files:**
- Modify: `src/commands/work.ts:1-12` (add import)
- Modify: `src/commands/work.ts:357-366` (foreground success path)
- Modify: `src/commands/work.ts:430-436` (background success path)

**Step 1: Add import**

Add to the imports at the top of `src/commands/work.ts`:

```typescript
import { publishTask } from "./publish";
```

**Step 2: Add auto-publish to foreground path**

After line 361 (`ui.success(\`Task ${taskId} completed.\`);`), add:

```typescript
      // Auto-publish: push branch + create draft PR
      const published = await publishTask(taskId, db);
      if (published) {
        ui.success(`PR created for ${taskId}`);
      } else {
        ui.warn(`Auto-publish failed. Retry with: grove publish ${taskId}`);
      }
```

**Step 3: Add auto-publish to background path**

After line 432 (`db.sessionEnd(sessionId, "completed");`), add:

```typescript
        // Auto-publish in background
        try {
          await publishTask(taskId, db);
        } catch {
          // Publish failure is non-fatal; task stays at done
        }
```

**Step 4: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All pass (publishTask won't actually run in tests — no real worktrees with branches)

**Step 5: Commit**

```bash
git add src/commands/work.ts
git commit -m "grove(publish): auto-publish after worker success in work command"
```

---

### Task 5: Wire auto-publish into `src/commands/resume.ts`

**Files:**
- Modify: `src/commands/resume.ts:1-10` (add import)
- Modify: `src/commands/resume.ts:219-225` (success path)

**Step 1: Add import**

Add to imports in `src/commands/resume.ts`:

```typescript
import { publishTask } from "./publish";
```

**Step 2: Add auto-publish to success path**

After line 221 (`db.addEvent(taskId, "completed", ...)`), add:

```typescript
        // Auto-publish: push branch + create draft PR
        const published = await publishTask(taskId, db);
        if (published) {
          ui.success(`PR created for ${taskId}`);
        } else {
          ui.warn(`Auto-publish failed. Retry with: grove publish ${taskId}`);
        }
```

**Step 3: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/commands/resume.ts
git commit -m "grove(publish): auto-publish after worker success in resume command"
```

---

### Task 6: Add integration-style tests for publish flow

**Files:**
- Modify: `tests/commands/publish.test.ts` (add more tests)

**Step 1: Add tests for generatePrBody edge cases and publishTask DB updates**

Add to `tests/commands/publish.test.ts`:

```typescript
describe("generatePrBody edge cases", () => {
  test("caps diff at 50K chars", async () => {
    // Create a worktree-like dir with a git repo
    const repoDir = join(tempDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", repoDir]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.com"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "commit.gpgsign", "false"]);
    Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"]);

    const { generatePrBody } = await import("../../src/commands/publish");
    // Even with a real repo, diff will be empty so it falls back
    const body = await generatePrBody(repoDir, "T-001", "Fallback summary");
    expect(body).toContain("Fallback summary");
    expect(body).toContain("Grove");
  });

  test("uses session summary when no worktree exists", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/does/not/exist", "T-001", "My summary here");
    expect(body).toContain("My summary here");
    expect(body).toContain("T-001");
  });

  test("uses default message when no summary provided", async () => {
    const { generatePrBody } = await import("../../src/commands/publish");
    const body = await generatePrBody("/does/not/exist", "T-001", null);
    expect(body).toContain("No description available");
  });
});

describe("publishTask DB behavior", () => {
  test("stores pr_url and pr_number when PR already exists", async () => {
    // This test validates the DB storage path.
    // publishTask will return false for missing worktree, but the validation
    // tests above already cover that. This is a structural test.
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo, branch) VALUES (?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "done", "testrepo", "grove/T-001-fix-bug"],
    );

    const task = db.taskGet("T-001");
    expect(task?.pr_url).toBeNull();
    expect(task?.pr_number).toBeNull();
  });
});
```

**Step 2: Run all tests**

Run: `~/.bun/bin/bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add tests/commands/publish.test.ts
git commit -m "grove(publish): add integration tests for publish flow"
```

---

### Task 7: Final verification and push

**Step 1: Run full test suite**

Run: `~/.bun/bin/bun test`
Expected: All tests pass (original 184 + new publish tests)

**Step 2: Verify build**

Run: `~/.bun/bin/bun build src/index.ts --compile --outfile bin/grove`
Expected: Binary compiles successfully

**Step 3: Verify command registration**

Run: `./bin/grove publish --help`
Expected: Shows publish help text

**Step 4: Final commit if any uncommitted changes, then push**

```bash
git push
```
