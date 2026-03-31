# PR Import and Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent-assisted PR review pipeline: import contributed PRs, check CI, run agent review, present verdict to maintainer.

**Architecture:** New `verdict` step type that pauses pipeline for human decision. PR-aware CI gate reuses `watchCI` from merge manager. Review worker checks out PR branch and writes structured report. Poller auto-imports external PRs.

**Tech Stack:** TypeScript/Bun, SQLite, `gh` CLI, React

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `"verdict"` to PipelineStep type union, add `source_pr` to Task |
| `src/broker/schema-sql.ts` | Modify | Add `source_pr` column to tasks schema |
| `src/broker/db.ts` | Modify | Add migration for `source_pr` column |
| `src/engine/normalize.ts` | Modify | Add `verdict` to TYPE_INFERENCE |
| `src/engine/step-engine.ts` | Modify | Add `verdict` case to `executeStep` |
| `src/broker/server.ts` | Modify | Add verdict API, import-prs endpoint, PR review config |
| `src/merge/github.ts` | Modify | Add `ghPrView`, `ghPrReview`, `ghPrClose` helpers |
| `src/pr/poller.ts` | Create | PR polling for auto-import |
| `src/pr/checkout.ts` | Create | PR checkout into worktree |
| `web/src/components/VerdictPanel.tsx` | Create | Verdict UI with action buttons |
| `web/src/components/TaskDetail.tsx` | Modify | Render VerdictPanel for `waiting` tasks |
| `web/src/components/TaskList.tsx` | Modify | PR badge, import button |
| `web/src/components/Settings.tsx` | Modify | Import PRs button |
| `tests/engine/step-engine-verdict.test.ts` | Create | Verdict step type tests |
| `tests/pr/poller.test.ts` | Create | PR poller tests |
| `tests/pr/checkout.test.ts` | Create | PR checkout tests |
| `tests/merge/github-pr.test.ts` | Create | New gh PR helper tests |

---

### Task 1: Data Model — `source_pr` column and `verdict` step type

**Files:**
- Modify: `src/shared/types.ts:262-270`
- Modify: `src/broker/schema-sql.ts:17-44`
- Modify: `src/broker/db.ts:28-58`
- Modify: `src/engine/normalize.ts:3-6`

- [ ] **Step 1: Write failing test for verdict type inference**

Create `tests/engine/step-engine-verdict.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { normalizePath } from "../../src/engine/normalize";

describe("verdict step type", () => {
  test("'verdict' string infers verdict type", () => {
    const result = normalizePath({ description: "test", steps: ["verdict"] });
    expect(result.steps[0].type).toBe("verdict");
  });

  test("verdict step in pr-review path normalizes correctly", () => {
    const result = normalizePath({
      description: "PR review",
      steps: ["ci-check", "review", "verdict"],
    });
    expect(result.steps[0].type).toBe("gate");
    expect(result.steps[1].type).toBe("worker");
    expect(result.steps[2].type).toBe("verdict");
    expect(result.steps[2].on_success).toBe("$done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/engine/step-engine-verdict.test.ts -v`
Expected: FAIL — `"verdict"` not in PipelineStep type union

- [ ] **Step 3: Add verdict to PipelineStep type**

In `src/shared/types.ts`, change line 264:

```typescript
  type: "worker" | "gate" | "merge" | "verdict";
```

- [ ] **Step 4: Add verdict to TYPE_INFERENCE**

In `src/engine/normalize.ts`, change lines 3-6:

```typescript
const TYPE_INFERENCE: Record<string, PipelineStep["type"]> = {
  merge: "merge",
  evaluate: "gate",
  "ci-check": "gate",
  verdict: "verdict",
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/engine/step-engine-verdict.test.ts -v`
Expected: PASS

- [ ] **Step 6: Add source_pr to schema and migration**

In `src/broker/schema-sql.ts`, add after line 43 (`paused INTEGER DEFAULT 0`):

```sql
  source_pr INTEGER
```

In `src/broker/db.ts`, add after the `github_issue` migration block (after line 54):

```typescript
    // Add source_pr column (links task to contributed PR being reviewed)
    const hasSourcePr = cols.some(c => c.name === "source_pr");
    if (!hasSourcePr) {
      this.run("ALTER TABLE tasks ADD COLUMN source_pr INTEGER");
    }
```

In `src/shared/types.ts`, add `source_pr` to the Task interface (find the Task interface and add):

```typescript
  source_pr: number | null;
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/broker/schema-sql.ts src/broker/db.ts src/engine/normalize.ts tests/engine/step-engine-verdict.test.ts
git commit -m "feat: (W-041) add verdict step type and source_pr column"
```

---

### Task 2: Verdict Step Execution in Step Engine

**Files:**
- Modify: `src/engine/step-engine.ts:250-275`
- Test: `tests/engine/step-engine-verdict.test.ts`

- [ ] **Step 1: Write failing test for verdict step execution**

Append to `tests/engine/step-engine-verdict.test.ts`:

```typescript
import { beforeEach, afterEach, mock } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";

// Capture real modules before mocking
const _realConfig = await import("../../src/broker/config");
const _realWorker = await import("../../src/agents/worker");

mock.module("../../src/broker/config", () => ({
  ..._realConfig,
  configNormalizedPaths: () => ({
    "pr-review": {
      description: "PR review",
      steps: [
        { id: "ci-check", type: "gate" as const, on_success: "review", on_failure: "verdict", label: "CI Check" },
        { id: "review", type: "worker" as const, on_success: "verdict", on_failure: "$fail", label: "Review" },
        { id: "verdict", type: "verdict" as const, on_success: "$done", on_failure: "$fail", label: "Verdict" },
      ],
    },
  }),
}));

mock.module("../../src/agents/worker", () => ({
  ..._realWorker,
  spawnWorker: mock(() => {}),
}));

const { startPipeline, _setDb } = await import("../../src/engine/step-engine");

describe("verdict step execution", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    db.treeUpsert({ id: "tree-1", name: "Test Tree", path: "/tmp/test-tree" });
  });

  afterEach(async () => {
    bus.removeAll();
    await new Promise((r) => setTimeout(r, 10));
    cleanup();
  });

  test("verdict step sets status to waiting and paused", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index) VALUES (?, ?, 'active', 'tree-1', 'pr-review', 'verdict', 2)",
      ["T-300", "Review PR #42"],
    );
    _setDb(db);

    // Simulate step engine reaching verdict
    const { onStepComplete } = require("../../src/engine/step-engine");
    // Manually trigger the verdict step by importing executeStep indirectly
    // The verdict step should set waiting status
    const task = db.taskGet("T-300")!;
    // We need to test that when executeStep is called with a verdict step,
    // it sets status to waiting. Since executeStep is not exported, we test
    // via the pipeline transition: review success → verdict
    db.run("UPDATE tasks SET current_step = 'review', step_index = 1 WHERE id = 'T-300'");

    onStepComplete("T-300", "success");

    const updated = db.taskGet("T-300")!;
    expect(updated.status).toBe("waiting");
    expect(updated.paused).toBe(1);
    expect(updated.current_step).toBe("verdict");
  });

  test("verdict step emits verdict_waiting event", () => {
    db.run(
      "INSERT INTO tasks (id, title, status, tree_id, path_name, current_step, step_index) VALUES (?, ?, 'active', 'tree-1', 'pr-review', 'review', 1)",
      ["T-301", "Review PR #43"],
    );
    _setDb(db);

    const { onStepComplete } = require("../../src/engine/step-engine");
    onStepComplete("T-301", "success");

    const events = db.eventsByTask("T-301");
    const verdictEvent = events.find(e => e.event_type === "verdict_waiting");
    expect(verdictEvent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/engine/step-engine-verdict.test.ts -v`
Expected: FAIL — verdict case not in executeStep

- [ ] **Step 3: Add verdict case to executeStep**

In `src/engine/step-engine.ts`, add a new case in the `executeStep` switch (after the `merge` case, before `default`):

```typescript
    case "verdict": {
      db.run(
        "UPDATE tasks SET status = 'waiting', paused = 1 WHERE id = ?",
        [task.id],
      );
      db.addEvent(task.id, null, "verdict_waiting", "Awaiting maintainer decision");
      bus.emit("task:status", { taskId: task.id, status: "waiting" });
      // Pipeline pauses here — no onStepComplete. Human acts via /api/tasks/:id/verdict
      break;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/engine/step-engine-verdict.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/engine/step-engine.ts tests/engine/step-engine-verdict.test.ts
git commit -m "feat: (W-041) implement verdict step execution in step engine"
```

---

### Task 3: GitHub PR Helpers — view, review, close

**Files:**
- Modify: `src/merge/github.ts`
- Create: `tests/merge/github-pr.test.ts`

- [ ] **Step 1: Write tests for new gh helpers**

Create `tests/merge/github-pr.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

// These are integration tests that require `gh` CLI.
// For unit testing, we verify the function signatures and argument construction.
// The actual gh calls are tested in CI against a real repo.

describe("ghPrView", () => {
  test("is exported and callable", async () => {
    const { ghPrView } = await import("../../src/merge/github");
    expect(typeof ghPrView).toBe("function");
  });
});

describe("ghPrReview", () => {
  test("is exported and callable", async () => {
    const { ghPrReview } = await import("../../src/merge/github");
    expect(typeof ghPrReview).toBe("function");
  });
});

describe("ghPrClose", () => {
  test("is exported and callable", async () => {
    const { ghPrClose } = await import("../../src/merge/github");
    expect(typeof ghPrClose).toBe("function");
  });
});

describe("ghPrCheckout", () => {
  test("is exported and callable", async () => {
    const { ghPrCheckout } = await import("../../src/merge/github");
    expect(typeof ghPrCheckout).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/merge/github-pr.test.ts -v`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add gh helper functions**

In `src/merge/github.ts`, add after the `ghPrList` function (after line 143):

```typescript
export interface GhPrDetail {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  author: { login: string };
  body: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function ghPrView(repo: string, prNumber: number): GhPrDetail | null {
  const result = gh([
    "pr", "view", String(prNumber), "-R", repo,
    "--json", "number,title,state,url,headRefName,headRefOid,author,body,mergeable,additions,deletions,changedFiles",
  ]);
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function ghPrReview(repo: string, prNumber: number, opts: {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}): boolean {
  const args = [
    "pr", "review", String(prNumber), "-R", repo,
    "--body", opts.body,
  ];
  if (opts.event === "APPROVE") args.push("--approve");
  else if (opts.event === "REQUEST_CHANGES") args.push("--request-changes");
  else args.push("--comment");
  return gh(args).ok;
}

export function ghPrClose(repo: string, prNumber: number, comment?: string): boolean {
  const args = ["pr", "close", String(prNumber), "-R", repo];
  if (comment) args.push("--comment", comment);
  return gh(args).ok;
}

export function ghPrCheckout(repo: string, prNumber: number, cwd: string): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(
    ["gh", "pr", "checkout", String(prNumber), "-R", repo, "--detach"],
    { cwd, stdin: "ignore", stderr: "pipe" },
  );
  return { ok: result.exitCode === 0, stderr: result.stderr.toString().trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/merge/github-pr.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/merge/github.ts tests/merge/github-pr.test.ts
git commit -m "feat: (W-041) add gh PR view, review, close, and checkout helpers"
```

---

### Task 4: PR Import API Endpoint

**Files:**
- Modify: `src/broker/server.ts`
- Create: `tests/pr/poller.test.ts`

- [ ] **Step 1: Write test for PR import filtering**

Create `tests/pr/poller.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

/** Filter PRs — exclude those with branches matching the grove prefix */
function filterExternalPRs(
  prs: Array<{ number: number; headRefName: string }>,
  branchPrefix: string,
): Array<{ number: number; headRefName: string }> {
  return prs.filter(pr => !pr.headRefName.startsWith(branchPrefix));
}

describe("filterExternalPRs", () => {
  const prs = [
    { number: 1, headRefName: "grove/W-001-fix-bug" },
    { number: 2, headRefName: "feature/add-pagination" },
    { number: 3, headRefName: "grove/W-002-refactor" },
    { number: 4, headRefName: "fix/typo-in-readme" },
    { number: 5, headRefName: "peter/grove/W-003-test" },
  ];

  test("excludes PRs with grove/ prefix", () => {
    const result = filterExternalPRs(prs, "grove/");
    expect(result.map(p => p.number)).toEqual([2, 4, 5]);
  });

  test("handles empty PR list", () => {
    expect(filterExternalPRs([], "grove/")).toEqual([]);
  });

  test("handles custom prefix", () => {
    const result = filterExternalPRs(prs, "peter/");
    expect(result.map(p => p.number)).toEqual([1, 2, 3, 4]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (pure function, test-first but trivial)

Run: `bun test tests/pr/poller.test.ts -v`
Expected: PASS — the function is defined inline in the test

- [ ] **Step 3: Create PR poller module**

Create `src/pr/poller.ts`:

```typescript
// Grove v3 — PR poller: auto-import contributed PRs for review
import { bus } from "../broker/event-bus";
import type { Database } from "../broker/db";
import type { Tree } from "../shared/types";

interface PrReviewConfig {
  enabled: boolean;
  poll_interval: number;
  auto_dispatch: boolean;
  prompt?: string;
}

/** Parse pr_review config from tree config JSON */
export function parsePrReviewConfig(treeConfig: string | null): PrReviewConfig | null {
  if (!treeConfig) return null;
  try {
    const parsed = JSON.parse(treeConfig);
    const pr = parsed.pr_review;
    if (!pr?.enabled) return null;
    return {
      enabled: true,
      poll_interval: pr.poll_interval ?? 300,
      auto_dispatch: pr.auto_dispatch ?? false,
      prompt: pr.prompt,
    };
  } catch { return null; }
}

/** Filter PRs — exclude those with branches matching the grove prefix */
export function filterExternalPRs<T extends { headRefName: string }>(
  prs: T[],
  branchPrefix: string,
): T[] {
  return prs.filter(pr => !pr.headRefName.startsWith(branchPrefix));
}

/** Import a single PR as a draft task. Returns task ID or null if already imported. */
export function importPr(
  db: Database,
  tree: Tree,
  pr: { number: number; title: string; body?: string; headRefName: string },
): string | null {
  // Check if already imported
  const existing = db.get<{ id: string }>(
    "SELECT id FROM tasks WHERE tree_id = ? AND source_pr = ?",
    [tree.id, pr.number],
  );
  if (existing) return null;

  const taskId = db.nextTaskId("W");
  db.run(
    "INSERT INTO tasks (id, tree_id, title, description, path_name, status, source_pr) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
    [taskId, tree.id, `PR #${pr.number}: ${pr.title}`, pr.body ?? "", "pr-review", pr.number],
  );
  db.addEvent(taskId, null, "task_created", `Imported from ${tree.github} PR #${pr.number}`);
  bus.emit("task:created", { task: db.taskGet(taskId)! });
  return taskId;
}

let _interval: ReturnType<typeof setInterval> | null = null;

/** Start polling for new PRs on all configured trees */
export function startPrPoller(db: Database): void {
  if (_interval) return;

  const poll = async () => {
    const trees = db.all<Tree>("SELECT * FROM trees WHERE github IS NOT NULL");
    for (const tree of trees) {
      const config = parsePrReviewConfig(tree.config);
      if (!config) continue;

      try {
        const { ghPrList } = await import("../merge/github");
        const prs = ghPrList(tree.github!, { state: "open", limit: 50 });
        const external = filterExternalPRs(prs, tree.branch_prefix);

        for (const pr of external) {
          const taskId = importPr(db, tree, pr);
          if (taskId && config.auto_dispatch) {
            const { enqueue } = await import("../broker/dispatch");
            db.taskSetStatus(taskId, "queued");
            enqueue(taskId);
          }
        }
      } catch (err: any) {
        db.addEvent(null, null, "pr_poll_error", `PR poll failed for ${tree.github}: ${err.message}`);
      }
    }
  };

  // Run immediately, then on interval
  poll();
  _interval = setInterval(poll, 300_000); // 5 min default, overridden per-tree in future
}

/** Stop the PR poller */
export function stopPrPoller(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
```

- [ ] **Step 4: Update poller test to use the module**

Replace `tests/pr/poller.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { filterExternalPRs, parsePrReviewConfig } from "../../src/pr/poller";

describe("filterExternalPRs", () => {
  const prs = [
    { number: 1, headRefName: "grove/W-001-fix-bug" },
    { number: 2, headRefName: "feature/add-pagination" },
    { number: 3, headRefName: "grove/W-002-refactor" },
    { number: 4, headRefName: "fix/typo-in-readme" },
    { number: 5, headRefName: "peter/grove/W-003-test" },
  ];

  test("excludes PRs with grove/ prefix", () => {
    const result = filterExternalPRs(prs, "grove/");
    expect(result.map(p => p.number)).toEqual([2, 4, 5]);
  });

  test("handles empty PR list", () => {
    expect(filterExternalPRs([], "grove/")).toEqual([]);
  });

  test("handles custom prefix", () => {
    const result = filterExternalPRs(prs, "peter/");
    expect(result.map(p => p.number)).toEqual([1, 2, 3, 4]);
  });
});

describe("parsePrReviewConfig", () => {
  test("returns null for null config", () => {
    expect(parsePrReviewConfig(null)).toBeNull();
  });

  test("returns null when pr_review not enabled", () => {
    expect(parsePrReviewConfig(JSON.stringify({ pr_review: { enabled: false } }))).toBeNull();
  });

  test("returns null when no pr_review key", () => {
    expect(parsePrReviewConfig(JSON.stringify({ quality_gates: {} }))).toBeNull();
  });

  test("parses enabled config with defaults", () => {
    const config = parsePrReviewConfig(JSON.stringify({ pr_review: { enabled: true } }));
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.poll_interval).toBe(300);
    expect(config!.auto_dispatch).toBe(false);
  });

  test("parses custom values", () => {
    const config = parsePrReviewConfig(JSON.stringify({
      pr_review: { enabled: true, poll_interval: 60, auto_dispatch: true, prompt: "Custom review" },
    }));
    expect(config!.poll_interval).toBe(60);
    expect(config!.auto_dispatch).toBe(true);
    expect(config!.prompt).toBe("Custom review");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/pr/poller.test.ts -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pr/poller.ts tests/pr/poller.test.ts
git commit -m "feat: (W-041) add PR poller with filtering and auto-import"
```

---

### Task 5: Verdict API Endpoint

**Files:**
- Modify: `src/broker/server.ts`

- [ ] **Step 1: Add import-prs endpoint**

In `src/broker/server.ts`, add after the `import-issues` endpoint block (after line 443):

```typescript
    // POST /api/trees/:id/import-prs — create tasks from open contributed PRs
    const importPrsMatch = path.match(/^\/api\/trees\/([^/]+)\/import-prs$/);
    if (importPrsMatch && req.method === "POST") {
      const tree = db.treeGet(importPrsMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json({ error: "No GitHub repo configured" }, 400);

      try {
        const { ghPrList } = await import("../merge/github");
        const { filterExternalPRs, importPr } = await import("../pr/poller");
        const prs = ghPrList(tree.github, { state: "open", limit: 50 });
        const external = filterExternalPRs(prs, tree.branch_prefix);

        let imported = 0;
        for (const pr of external) {
          const taskId = importPr(db, tree, pr);
          if (taskId) imported++;
        }

        return json({ ok: true, imported, skipped: external.length - imported, total: prs.length, external: external.length });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    }
```

- [ ] **Step 2: Add verdict endpoint**

In `src/broker/server.ts`, add after the resume endpoint:

```typescript
    // POST /api/tasks/:id/verdict — maintainer decision on PR review
    const verdictMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/verdict$/);
    if (verdictMatch && req.method === "POST") {
      const taskId = verdictMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      if (task.status !== "waiting") return json({ error: "Task is not awaiting verdict" }, 400);
      if (!task.source_pr || !task.tree_id) return json({ error: "Task has no source PR" }, 400);

      const tree = db.treeGet(task.tree_id);
      if (!tree?.github) return json({ error: "Tree has no GitHub repo" }, 400);

      let body: { action: string; comment?: string };
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      const { action, comment } = body;

      switch (action) {
        case "merge": {
          const { ghPrMerge } = await import("../merge/github");
          const merged = ghPrMerge(tree.github, task.source_pr);
          if (!merged) return json({ error: "Merge failed — PR may have conflicts" }, 500);
          db.run("UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now'), paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_merge", `Maintainer merged PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "completed" });
          return json({ ok: true, action: "merge" });
        }

        case "request_changes": {
          const { ghPrReview } = await import("../merge/github");
          const posted = ghPrReview(tree.github, task.source_pr, {
            event: "REQUEST_CHANGES",
            body: comment ?? "Changes requested.",
          });
          db.run("UPDATE tasks SET status = 'deferred', paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_request_changes", `Maintainer requested changes on PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "deferred" });
          return json({ ok: true, action: "request_changes", posted });
        }

        case "close": {
          const { ghPrClose } = await import("../merge/github");
          ghPrClose(tree.github, task.source_pr, comment);
          db.run("UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now'), paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_close", `Maintainer closed PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "completed" });
          return json({ ok: true, action: "close" });
        }

        case "defer": {
          db.addEvent(taskId, null, "verdict_defer", "Maintainer deferred decision");
          return json({ ok: true, action: "defer" });
        }

        default:
          return json({ error: `Unknown action: ${action}` }, 400);
      }
    }
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: (W-041) add verdict API and import-prs endpoint"
```

---

### Task 6: Verdict Panel UI

**Files:**
- Create: `web/src/components/VerdictPanel.tsx`
- Modify: `web/src/components/TaskDetail.tsx`

- [ ] **Step 1: Create VerdictPanel component**

Create `web/src/components/VerdictPanel.tsx`:

```tsx
import { useState } from "react";
import { api } from "../api/client";
import type { Task } from "../hooks/useTasks";

interface Props {
  task: Task;
  onAction: () => void;
}

export default function VerdictPanel({ task, onAction }: Props) {
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: string) => {
    setActing(true);
    setError(null);
    try {
      const body: Record<string, string> = { action };
      if (comment.trim()) body.comment = comment;
      await api(`/api/tasks/${task.id}/verdict`, { method: "POST", body: JSON.stringify(body) });
      onAction();
    } catch (err: any) {
      setError(err.message ?? "Action failed");
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* PR metadata */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
        {task.source_pr && <span>PR #{task.source_pr}</span>}
        {task.branch && <span className="font-mono text-zinc-500">{task.branch}</span>}
      </div>

      {/* Review report from session_summary */}
      {task.session_summary && (
        <div className="bg-zinc-800/50 rounded-lg p-3 text-xs text-zinc-300 whitespace-pre-wrap max-h-80 overflow-y-auto">
          {task.session_summary}
        </div>
      )}

      {/* Comment editor (shown for request_changes and close) */}
      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment to post on the PR..."
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 min-h-[80px]"
        />
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => act("merge")}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
        >
          Merge
        </button>
        <button
          onClick={() => { setShowComment(true); act("request_changes"); }}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
        >
          Request Changes
        </button>
        <button
          onClick={() => { setShowComment(true); act("close"); }}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
        >
          Close
        </button>
        <button
          onClick={() => act("defer")}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-700 text-zinc-400 hover:bg-zinc-600 disabled:opacity-50"
        >
          Defer
        </button>
        {!showComment && (
          <button
            onClick={() => setShowComment(true)}
            className="px-3 py-1.5 rounded text-xs text-zinc-500 hover:text-zinc-300"
          >
            + Comment
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire VerdictPanel into TaskDetail**

In `web/src/components/TaskDetail.tsx`, add import at the top:

```typescript
import VerdictPanel from "./VerdictPanel";
```

In the component body, add after the seed section and before the closing `</div>`, a section for the verdict panel:

```tsx
      {/* Verdict panel for PR review tasks awaiting decision */}
      {task.status === "waiting" && task.source_pr && (
        <div>
          <Label>Verdict</Label>
          <VerdictPanel task={task} onAction={() => window.location.reload()} />
        </div>
      )}
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/components/VerdictPanel.tsx web/src/components/TaskDetail.tsx
git commit -m "feat: (W-041) add verdict panel UI for PR review decisions"
```

---

### Task 7: Import PRs Button in Settings + PR Badge in Task List

**Files:**
- Modify: `web/src/components/Settings.tsx`
- Modify: `web/src/components/TaskList.tsx`

- [ ] **Step 1: Add Import PRs button to Settings**

In `web/src/components/Settings.tsx`, find the "Import Issues" button pattern and add a matching "Import PRs" button after it. The button calls `POST /api/trees/${tree.id}/import-prs` and shows a result message (same pattern as import-issues).

Find the existing import-issues button handler and add below it:

```typescript
  const importPrs = async (treeId: string) => {
    try {
      const data = await api<any>(`/api/trees/${treeId}/import-prs`, { method: "POST" });
      alert(`${data.imported} PR(s) imported, ${data.skipped} skipped (${data.external} external of ${data.total} open)`);
    } catch (err: any) {
      alert(`Import failed: ${err.message}`);
    }
  };
```

Add a button next to the existing "Import Issues" button:

```tsx
<button
  onClick={() => importPrs(tree.id)}
  className="text-xs px-2 py-1 rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
>
  Import PRs
</button>
```

- [ ] **Step 2: Add PR badge to task cards in TaskList**

In `web/src/components/TaskList.tsx`, in the task card metadata section (where tree_id and task id are shown), add a PR indicator:

```tsx
{task.source_pr && (
  <span className="text-purple-400" title={`PR #${task.source_pr}`}>PR</span>
)}
```

Add this inside the `<div className="flex gap-2 text-xs text-zinc-500 mt-1">` block, after the tree_id span.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Settings.tsx web/src/components/TaskList.tsx
git commit -m "feat: (W-041) add Import PRs button and PR badge in task list"
```

---

### Task 8: Wire Poller into Broker Startup + Add `pr-review` Default Path

**Files:**
- Modify: `src/broker/index.ts`
- Modify: `grove.yaml.example`

- [ ] **Step 1: Start PR poller on broker startup**

In `src/broker/index.ts`, find where the broker initializes services (dispatch, cost monitor, etc.) and add:

```typescript
import { startPrPoller, stopPrPoller } from "../pr/poller";

// After other init calls:
startPrPoller(db);
```

And in the shutdown handler, add `stopPrPoller()`.

- [ ] **Step 2: Add `pr-review` path to default config**

In `grove.yaml.example`, add under `paths:`:

```yaml
  pr-review:
    description: Review contributed PR
    steps:
      - ci-check:
          type: gate
          on_failure: verdict
      - review:
          prompt: "Review this contributed PR. Check out the PR branch, read the diff, and write a structured review report to .grove/pr-review.md. Analyze for: backwards compatibility, test coverage, code quality, and adherence to project conventions. Include a clear verdict (Recommend Merge / Request Changes / Needs Discussion) and specific suggested comments per file."
      - verdict
```

Note: `ci-check` has `on_failure: verdict` — if CI fails, skip review and go straight to verdict with the CI failure context.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/broker/index.ts grove.yaml.example
git commit -m "feat: (W-041) wire PR poller to broker startup, add pr-review default path"
```

---

### Task 9: CHANGELOG + Final Verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entry**

Add under `## Unreleased`:

```markdown
### Added
- **PR Import and Review** — import contributed PRs for agent-assisted review
  - New `pr-review` pipeline path: CI gate → agent review → maintainer verdict
  - New `verdict` step type: pauses pipeline for human decision (merge/request changes/close/defer)
  - PR auto-import via polling (configurable per tree in `grove.yaml`)
  - Manual import via API, CLI, and GUI ("Import PRs" button)
  - Verdict panel in task detail with action buttons and review report display
  - New `source_pr` column on tasks to track contributed PR number
  - GitHub helpers: `ghPrView`, `ghPrReview`, `ghPrClose`, `ghPrCheckout`
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass, 0 errors

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: (W-041) add PR import and review to changelog"
```
