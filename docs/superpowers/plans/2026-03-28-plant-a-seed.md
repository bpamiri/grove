# Plant a Seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive brainstorming sessions to Grove tasks via "Plant a Seed" — producing structured design artifacts that guide workers during implementation.

**Architecture:** Each seed session is an interactive Claude Code process in a tmux window, communicating with the frontend via WebSocket. Seeds are stored in a `seeds` DB table and injected into worker CLAUDE.md overlays. The frontend renders an inline chat with visual mockup support inside the task detail panel. HTML fragments from the AI are sanitized with DOMPurify before rendering.

**Tech Stack:** Bun (broker), SQLite (seeds table), React + TypeScript (frontend), tmux (session management), WebSocket (real-time communication), DOMPurify (HTML sanitization).

**Spec:** `docs/superpowers/specs/2026-03-28-plant-a-seed-design.md`

---

### Task 1: Add seeds table to schema and DB methods

**Files:**
- Modify: `src/broker/schema.sql`
- Modify: `src/broker/schema-sql.ts`
- Modify: `src/broker/db.ts`
- Test: `tests/broker/db-seeds.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/broker/db-seeds.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { Database } from "../../src/broker/db";

const TEST_DIR = join(import.meta.dir, "test-seeds");
const DB_PATH = join(TEST_DIR, "test.db");

let db: Database;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(DB_PATH);
  const { SCHEMA_SQL } = require("../../src/broker/schema-sql");
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
});

describe("seed operations", () => {
  test("seedCreate creates a seed with active status", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    const seed = db.seedGet("W-001");
    expect(seed).not.toBeNull();
    expect(seed!.task_id).toBe("W-001");
    expect(seed!.status).toBe("active");
    expect(seed!.summary).toBeNull();
    expect(seed!.spec).toBeNull();
  });

  test("seedGet returns null for non-existent seed", () => {
    expect(db.seedGet("W-999")).toBeNull();
  });

  test("seedComplete sets summary, spec, and status", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedComplete("W-001", "JWT auth design", "# Auth Spec\nUse JWT...");
    const seed = db.seedGet("W-001");
    expect(seed!.status).toBe("completed");
    expect(seed!.summary).toBe("JWT auth design");
    expect(seed!.spec).toBe("# Auth Spec\nUse JWT...");
    expect(seed!.completed_at).not.toBeNull();
  });

  test("seedUpdateConversation stores JSON", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    const msgs = [{ source: "ai", content: "Hello" }, { source: "user", content: "Hi" }];
    db.seedUpdateConversation("W-001", msgs);
    const seed = db.seedGet("W-001");
    expect(JSON.parse(seed!.conversation!)).toEqual(msgs);
  });

  test("seedDiscard sets status to discarded", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedDiscard("W-001");
    const seed = db.seedGet("W-001");
    expect(seed!.status).toBe("discarded");
  });

  test("seedDelete removes the seed", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedDelete("W-001");
    expect(db.seedGet("W-001")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/db-seeds.test.ts`
Expected: FAIL — `seedCreate` method does not exist.

- [ ] **Step 3: Add seeds table to schema.sql**

Append before the indexes section in `src/broker/schema.sql` (before line 83 `-- Indexes`):

```sql
-- Seeds: brainstorming design artifacts attached to tasks
CREATE TABLE IF NOT EXISTS seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  summary TEXT,
  spec TEXT,
  conversation TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
```

And add an index (with the other indexes at the bottom):

```sql
CREATE INDEX IF NOT EXISTS idx_seeds_task ON seeds(task_id);
```

- [ ] **Step 4: Regenerate schema-sql.ts**

Read `src/broker/schema.sql` and update the `SCHEMA_SQL` template string in `src/broker/schema-sql.ts` to include the seeds table. The file is just a string export of the SQL.

- [ ] **Step 5: Add seed CRUD methods to db.ts**

Add these methods to the `Database` class in `src/broker/db.ts` (at the end of the class, before the closing brace):

```typescript
  // ---- Seed operations ----

  seedCreate(taskId: string): void {
    this.run(
      "INSERT OR REPLACE INTO seeds (task_id, status) VALUES (?, 'active')",
      [taskId],
    );
  }

  seedGet(taskId: string): {
    id: number; task_id: string; summary: string | null; spec: string | null;
    conversation: string | null; status: string; created_at: string; completed_at: string | null;
  } | null {
    return this.get(
      "SELECT * FROM seeds WHERE task_id = ? AND status != 'discarded'",
      [taskId],
    );
  }

  seedComplete(taskId: string, summary: string, spec: string): void {
    this.run(
      "UPDATE seeds SET summary = ?, spec = ?, status = 'completed', completed_at = datetime('now') WHERE task_id = ? AND status = 'active'",
      [summary, spec, taskId],
    );
  }

  seedUpdateConversation(taskId: string, messages: any[]): void {
    this.run(
      "UPDATE seeds SET conversation = ? WHERE task_id = ? AND status = 'active'",
      [JSON.stringify(messages), taskId],
    );
  }

  seedDiscard(taskId: string): void {
    this.run(
      "UPDATE seeds SET status = 'discarded' WHERE task_id = ? AND status IN ('active', 'completed')",
      [taskId],
    );
  }

  seedDelete(taskId: string): void {
    this.run("DELETE FROM seeds WHERE task_id = ?", [taskId]);
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/broker/db-seeds.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/broker/schema.sql src/broker/schema-sql.ts src/broker/db.ts tests/broker/db-seeds.test.ts
git commit -m "feat: add seeds table and CRUD methods for brainstorming artifacts"
```

---

### Task 2: Create seed session manager

**Files:**
- Create: `src/broker/seed-session.ts`

This is the core backend module. It manages interactive Claude Code sessions in tmux for brainstorming.

- [ ] **Step 1: Create seed-session.ts**

Create `src/broker/seed-session.ts` with the full implementation. This file:
- Builds a CLAUDE.md prompt for the seed session (brainstorming guidelines, visual mockup protocol, seed completion format)
- Spawns an interactive Claude Code session in a `seed-{taskId}` tmux window
- Polls the tmux pane for responses (same pattern as orchestrator)
- Scans for structured JSON events: `seed_html` (visual mockups) and `seed_complete` (final artifact)
- Routes messages between WebSocket and tmux
- Manages lifecycle: start, send, stop, cleanup

The seed prompt instructs the AI to:
1. Explore codebase context
2. Ask clarifying questions one at a time (prefer multiple choice)
3. Propose 2-3 approaches with trade-offs
4. Present design section by section
5. Emit `{"type":"seed_complete","summary":"...","spec":"..."}` when done

For visual mockups, the AI emits `{"type":"seed_html","html":"<content fragment>"}` which renders inline in the frontend.

Key functions exported: `startSeedSession`, `sendSeedMessage`, `stopSeedSession`, `isSeedSessionActive`, `getSeedConversation`, `setSeedBroadcast`.

The response parser reuses the same `⏺`/`❯` tmux output parsing pattern from `src/agents/orchestrator.ts`.

- [ ] **Step 2: Verify build**

Run: `bun build src/broker/seed-session.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/broker/seed-session.ts
git commit -m "feat: seed session manager — tmux-based interactive brainstorming"
```

---

### Task 3: Wire seed sessions into WebSocket server and REST API

**Files:**
- Modify: `src/broker/server.ts`

- [ ] **Step 1: Add seed imports and broadcast wiring**

At the top of `src/broker/server.ts`, add import:

```typescript
import { startSeedSession, sendSeedMessage, stopSeedSession, isSeedSessionActive, setSeedBroadcast } from "./seed-session";
```

In the `startServer` function, after the `wireEventBus()` call, add:

```typescript
  setSeedBroadcast(broadcast);
```

- [ ] **Step 2: Add seed WebSocket message handlers**

In the websocket `message` handler, after the `if (data.type === "action")` block, add handlers for `seed`, `seed_start`, and `seed_stop` message types. These route to `sendSeedMessage`, `startSeedSession`, and `stopSeedSession` respectively. The `seed_start` handler needs to look up the task and tree from DB.

- [ ] **Step 3: Add seed REST API endpoints**

In the `handleApi` function, before the final 404 response, add:
- `GET /api/tasks/:id/seed` — returns seed with active status and parsed conversation
- `POST /api/tasks/:id/seed/start` — starts a seed session (looks up task + tree)
- `POST /api/tasks/:id/seed/stop` — stops a seed session
- `DELETE /api/tasks/:id/seed` — stops session + discards seed (for re-seed)

Also update `GET /api/tasks` to annotate tasks with `has_seed` and `seed_status` by joining against the seeds table.

- [ ] **Step 4: Verify build**

Run: `bun build src/broker/server.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: wire seed sessions into WebSocket and REST API"
```

---

### Task 4: Create frontend seed hook and components

**Files:**
- Create: `web/src/hooks/useSeed.ts`
- Create: `web/src/components/SeedChat.tsx`
- Create: `web/src/components/SeedBadge.tsx`
- Create: `web/src/components/SeedFrame.css`
- Modify: `web/package.json` (add dompurify)

- [ ] **Step 1: Install DOMPurify**

Run: `cd web && bun add dompurify @types/dompurify`

- [ ] **Step 2: Create useSeed hook**

Create `web/src/hooks/useSeed.ts` — manages seed state per task:
- Loads seed from `GET /api/tasks/:id/seed` on task change
- Provides `startSeed`, `stopSeed`, `sendMessage`, `discardSeed` actions
- Handles WebSocket messages: `seed:message`, `seed:started`, `seed:complete`, `seed:stopped`
- Tracks `messages` array, `isActive`, `isSeeded` state
- Auto-scrolls via `bottomRef`

- [ ] **Step 3: Create SeedFrame.css**

Create `web/src/components/SeedFrame.css` with CSS classes for visual mockup rendering:
- `.seed-html-frame` — container with dark theme
- `.options` — auto-fit grid for option cards
- `.cards [data-choice]` — clickable option cards with hover/selected states (emerald accent)
- `.split`, `.pros-cons` — two-column layouts
- Typography overrides for headings and links

- [ ] **Step 4: Create SeedBadge.tsx**

Create `web/src/components/SeedBadge.tsx` — small `🌱` indicator badge with emerald styling. Accepts `size` prop (sm/md).

- [ ] **Step 5: Create SeedChat.tsx**

Create `web/src/components/SeedChat.tsx` — the inline brainstorming chat. Three render states:

**No seed:** Shows "Plant a Seed" button (emerald accent, calls `onStart`)

**Active session:** Shows chat panel with:
- Header ("Seeding..." with animated seed icon and close button)
- Scrollable message list (AI messages left-aligned emerald, user messages right-aligned)
- HTML fragments rendered in `.seed-html-frame` containers via DOMPurify sanitization
- `data-choice` click handling that sends selections back
- Text input at bottom

**Completed seed:** Shows collapsed summary with expand toggle. Expanded view shows full spec markdown. "Re-seed" button at bottom.

**Important:** All HTML fragments from the AI MUST be sanitized with DOMPurify before rendering. Use `DOMPurify.sanitize(html, { ADD_ATTR: ['data-choice'] })` to allow the `data-choice` attribute through sanitization while stripping dangerous content. Render the sanitized HTML into a div with `dangerouslySetInnerHTML`.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lock web/src/hooks/useSeed.ts web/src/components/SeedChat.tsx web/src/components/SeedBadge.tsx web/src/components/SeedFrame.css
git commit -m "feat: seed frontend — useSeed hook, SeedChat, SeedBadge, SeedFrame CSS"
```

---

### Task 5: Integrate seed into TaskDetail, TaskList, and App

**Files:**
- Modify: `web/src/components/TaskDetail.tsx`
- Modify: `web/src/components/TaskList.tsx`
- Modify: `web/src/hooks/useTasks.ts`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Add has_seed to Task interface**

In `web/src/hooks/useTasks.ts`, add to the Task interface:

```typescript
  has_seed?: boolean;
  seed_status?: string | null;
```

- [ ] **Step 2: Update TaskDetail to accept and render seed props**

Add SeedChat import and seed-related props to the Props interface. Render the SeedChat component:
- For draft tasks: show below the description section (always, whether seeded or not)
- For non-draft tasks: show completed seed in collapsed view only (if seeded)

- [ ] **Step 3: Update TaskList to show seed badge and pass seed props**

Add SeedBadge import. Show `🌱` badge next to task title when `task.has_seed` is true.

Add `useSeed` hook call scoped to `expandedId`. Pass seed props through to TaskDetail.

TaskList needs access to the WebSocket `send` function — add it to props.

- [ ] **Step 4: Wire in App.tsx**

Pass `send` from `useWebSocket` to TaskList. Forward seed-related WebSocket messages to TaskList/useSeed.

- [ ] **Step 5: Build frontend**

Run: `cd web && bun run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TaskDetail.tsx web/src/components/TaskList.tsx web/src/hooks/useTasks.ts web/src/App.tsx
git commit -m "feat: integrate seed into TaskDetail, TaskList, and App"
```

---

### Task 6: Inject seed into worker sandbox and pipeline

**Files:**
- Modify: `src/shared/sandbox.ts`
- Modify: `src/agents/worker.ts`
- Modify: `src/engine/step-engine.ts`
- Modify: `src/agents/evaluator.ts`

- [ ] **Step 1: Add seedSpec to OverlayContext and buildOverlay**

In `src/shared/sandbox.ts`:
- Add `seedSpec?: string | null` to the `OverlayContext` interface
- In `buildOverlay`, inject the seed spec after the description section: "### Seed (Design Spec)" with a note to follow it closely

- [ ] **Step 2: Pass seed to deploySandbox from worker**

In `src/agents/worker.ts`, before the `deploySandbox` call, look up the seed from DB:

```typescript
const seed = db.seedGet(task.id);
const seedSpec = seed?.spec ?? null;
```

Add `seedSpec` to the deploySandbox context object.

- [ ] **Step 3: Skip plan step for seeded tasks**

In `src/engine/step-engine.ts`, in `startPipeline`: after getting `firstStep`, check if the task has a seed and the first step is `plan`. If so, advance to the second step and log a "step_skipped" event.

- [ ] **Step 4: Pass seed to evaluator retry prompt**

In `src/agents/evaluator.ts`, update `buildRetryPrompt` to accept an optional `seedSpec` parameter. When present, append the seed spec to the retry prompt so the worker maintains alignment with the original design.

- [ ] **Step 5: Verify build**

Run: `bun build src/shared/sandbox.ts --no-bundle 2>&1 | tail -3`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/sandbox.ts src/agents/worker.ts src/engine/step-engine.ts src/agents/evaluator.ts
git commit -m "feat: inject seed into workers, skip plan step, enhance evaluator"
```

---

### Task 7: Build, rebuild, and end-to-end test

**Files:**
- All files from previous tasks

- [ ] **Step 1: Run all tests**

Run: `bun test tests/`
Expected: All new tests pass (db-seeds). Pre-existing failures unchanged.

- [ ] **Step 2: Build frontend + embed + binary**

Run: `bun run build`
Expected: Web build succeeds, assets embedded, binary compiles.

- [ ] **Step 3: Test end-to-end**

```bash
grove down && grove up
```

Open the GUI. Navigate to a draft task. Verify:
1. "Plant a Seed" button is visible
2. Click it — seed chat panel expands inline
3. AI begins brainstorming session
4. Messages appear in the chat
5. Close button stops the session
6. Task list shows seed badge for seeded tasks

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: Plant a Seed — interactive brainstorming for Grove tasks"
```
