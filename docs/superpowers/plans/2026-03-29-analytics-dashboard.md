# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an analytics dashboard to Grove's web GUI with timeline, cost breakdown, and gate analytics — powered by SQL aggregation over existing tables with real-time WebSocket updates.

**Architecture:** Six new DB methods aggregate from existing tasks/sessions/events tables (no schema changes). Three REST endpoints expose this data. A React hook manages fetching + WS-driven refresh. A single Dashboard.tsx component renders three tabbed views (Overview, Costs, Gates) with CSS-only charts.

**Tech Stack:** Bun SQLite (json_each for gate parsing), Bun HTTP server, React 19, Tailwind 4, CSS bar charts

**Spec:** `docs/superpowers/specs/2026-03-29-analytics-dashboard-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/broker/db.ts` | Add 6 analytics query methods |
| Modify | `src/broker/server.ts` | Add 3 `/api/analytics/*` endpoints |
| Create | `web/src/hooks/useAnalytics.ts` | Fetch analytics data, WS-driven refresh |
| Create | `web/src/components/Dashboard.tsx` | Dashboard with tabs, KPI cards, Gantt timeline, cost/gate charts |
| Modify | `web/src/App.tsx` | Add "dashboard" view, render Dashboard component |
| Modify | `web/src/components/Sidebar.tsx` | Add Dashboard button to sidebar |
| Create | `tests/broker/db-analytics.test.ts` | Tests for all 6 DB analytics methods |
| Create | `tests/broker/server-analytics.test.ts` | Tests for 3 API analytics endpoints |

---

### Task 1: Analytics DB Methods — costByTree, costDaily, costTopTasks

**Files:**
- Modify: `src/broker/db.ts:297-309` (after costWeek method)
- Test: `tests/broker/db-analytics.test.ts` (create)

- [ ] **Step 1: Write the test file with cost method tests**

Create `tests/broker/db-analytics.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-analytics.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// Helper: insert a tree
function insertTree(id: string, name: string) {
  db.treeUpsert({ id, name, path: `/code/${id}` });
}

// Helper: insert a task with cost
function insertTask(
  id: string,
  treeId: string | null,
  opts: { status?: string; cost?: number; started_at?: string; completed_at?: string; gate_results?: string; retry_count?: number } = {}
) {
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, completed_at, gate_results, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, treeId, `Task ${id}`, opts.status ?? "completed",
      opts.cost ?? 0, opts.started_at ?? null, opts.completed_at ?? null,
      opts.gate_results ?? null, opts.retry_count ?? 0,
    ]
  );
}

describe("costByTree", () => {
  test("aggregates cost per tree", () => {
    insertTree("titan", "Titan");
    insertTree("grove", "Grove");
    const now = new Date().toISOString();
    insertTask("W-001", "titan", { cost: 2.5, started_at: now });
    insertTask("W-002", "titan", { cost: 1.5, started_at: now });
    insertTask("W-003", "grove", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costByTree(since);
    expect(result.length).toBe(2);

    const titan = result.find(r => r.tree_name === "Titan");
    expect(titan!.total_cost).toBe(4.0);
    expect(titan!.task_count).toBe(2);

    const grove = result.find(r => r.tree_name === "Grove");
    expect(grove!.total_cost).toBe(3.0);
    expect(grove!.task_count).toBe(1);
  });

  test("returns empty array when no tasks in range", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(db.costByTree(future)).toEqual([]);
  });

  test("excludes tasks without a tree", () => {
    const now = new Date().toISOString();
    insertTask("W-001", null, { cost: 5.0, started_at: now });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.costByTree(since)).toEqual([]);
  });
});

describe("costDaily", () => {
  test("groups cost by date", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { cost: 2.0, started_at: new Date().toISOString() });
    insertTask("W-002", "t", { cost: 3.0, started_at: new Date().toISOString() });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costDaily(since);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const today = result.find(r => r.date === new Date().toISOString().slice(0, 10));
    expect(today!.total_cost).toBe(5.0);
    expect(today!.task_count).toBe(2);
  });

  test("returns empty array when no tasks", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(db.costDaily(future)).toEqual([]);
  });
});

describe("costTopTasks", () => {
  test("returns tasks sorted by cost descending", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { cost: 1.0, started_at: now });
    insertTask("W-002", "t", { cost: 5.0, started_at: now });
    insertTask("W-003", "t", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costTopTasks(since, 2);
    expect(result.length).toBe(2);
    expect(result[0].task_id).toBe("W-002");
    expect(result[0].cost_usd).toBe(5.0);
    expect(result[1].task_id).toBe("W-003");
  });

  test("respects limit parameter", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { cost: 1.0, started_at: now });
    insertTask("W-002", "t", { cost: 2.0, started_at: now });
    insertTask("W-003", "t", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.costTopTasks(since, 1).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/db-analytics.test.ts`
Expected: FAIL — `db.costByTree is not a function`

- [ ] **Step 3: Implement costByTree, costDaily, costTopTasks in db.ts**

Add after the `costWeek()` method (line ~309) in `src/broker/db.ts`:

```typescript
  // ---- Analytics helpers ----

  costByTree(since: string): { tree_name: string; tree_id: string; total_cost: number; task_count: number }[] {
    return this.all(
      `SELECT t.name AS tree_name, t.id AS tree_id,
              COALESCE(SUM(tk.cost_usd), 0) AS total_cost,
              COUNT(tk.id) AS task_count
       FROM tasks tk
       JOIN trees t ON tk.tree_id = t.id
       WHERE tk.created_at >= ?
       GROUP BY t.id
       ORDER BY total_cost DESC`,
      [since]
    );
  }

  costDaily(since: string): { date: string; total_cost: number; task_count: number }[] {
    return this.all(
      `SELECT date(created_at) AS date,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(id) AS task_count
       FROM tasks
       WHERE created_at >= ?
       GROUP BY date(created_at)
       ORDER BY date ASC`,
      [since]
    );
  }

  costTopTasks(since: string, limit: number): { task_id: string; title: string; tree_name: string | null; cost_usd: number }[] {
    return this.all(
      `SELECT tk.id AS task_id, tk.title, t.name AS tree_name, tk.cost_usd
       FROM tasks tk
       LEFT JOIN trees t ON tk.tree_id = t.id
       WHERE tk.created_at >= ? AND tk.cost_usd > 0
       ORDER BY tk.cost_usd DESC
       LIMIT ?`,
      [since, limit]
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/db-analytics.test.ts`
Expected: All costByTree, costDaily, costTopTasks tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/db.ts tests/broker/db-analytics.test.ts
git commit -m "feat(analytics): add costByTree, costDaily, costTopTasks DB methods (#40)"
```

---

### Task 2: Analytics DB Methods — gateAnalytics, retryStats, taskTimeline

**Files:**
- Modify: `src/broker/db.ts` (append after Task 1's methods)
- Modify: `tests/broker/db-analytics.test.ts` (append new describe blocks)

- [ ] **Step 1: Add gate and timeline tests to db-analytics.test.ts**

Append to `tests/broker/db-analytics.test.ts`:

```typescript
describe("gateAnalytics", () => {
  test("aggregates pass/fail by gate type", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", {
      status: "completed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: true }, lint: { passed: true } }),
    });
    insertTask("W-002", "t", {
      status: "failed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: false, reason: "2 failures" }, lint: { passed: true } }),
    });
    insertTask("W-003", "t", {
      status: "completed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: true }, diff_size: { passed: false, reason: "too large" } }),
    });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.gateAnalytics(since);

    const tests = result.find(r => r.gate_type === "tests");
    expect(tests!.pass_count).toBe(2);
    expect(tests!.fail_count).toBe(1);
    expect(tests!.total).toBe(3);

    const lint = result.find(r => r.gate_type === "lint");
    expect(lint!.pass_count).toBe(2);
    expect(lint!.fail_count).toBe(0);

    const diff = result.find(r => r.gate_type === "diff_size");
    expect(diff!.pass_count).toBe(0);
    expect(diff!.fail_count).toBe(1);
  });

  test("returns empty when no gate_results", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { started_at: new Date().toISOString() });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.gateAnalytics(since)).toEqual([]);
  });
});

describe("retryStats", () => {
  test("aggregates retry statistics", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { started_at: now, retry_count: 2 });
    insertTask("W-002", "t", { started_at: now, retry_count: 0 });
    insertTask("W-003", "t", { started_at: now, retry_count: 3 });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.retryStats(since);
    expect(result.total_retried).toBe(2);
    expect(result.avg_retries).toBe(2.5);
    expect(result.max_retries).toBe(3);
  });

  test("returns zeros when no retries", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { started_at: new Date().toISOString(), retry_count: 0 });
    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.retryStats(since);
    expect(result.total_retried).toBe(0);
    expect(result.avg_retries).toBe(0);
    expect(result.max_retries).toBe(0);
  });
});

describe("taskTimeline", () => {
  test("returns tasks with timing data ordered by started_at", () => {
    insertTree("t", "T");
    const t1 = new Date(Date.now() - 3600000).toISOString();
    const t2 = new Date(Date.now() - 1800000).toISOString();
    insertTask("W-001", "t", { status: "completed", started_at: t1, completed_at: t2 });
    insertTask("W-002", "t", { status: "active", started_at: t2 });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.taskTimeline(since);
    expect(result.length).toBe(2);
    expect(result[0].task_id).toBe("W-001");
    expect(result[0].tree_name).toBe("T");
    expect(result[0].started_at).toBe(t1);
    expect(result[1].task_id).toBe("W-002");
    expect(result[1].completed_at).toBeNull();
  });

  test("excludes tasks without started_at", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "draft" });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.taskTimeline(since)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/db-analytics.test.ts`
Expected: gateAnalytics, retryStats, taskTimeline tests FAIL — methods not defined

- [ ] **Step 3: Implement gateAnalytics, retryStats, taskTimeline in db.ts**

Add after `costTopTasks` in `src/broker/db.ts`:

```typescript
  gateAnalytics(since: string): { gate_type: string; pass_count: number; fail_count: number; total: number }[] {
    return this.all(
      `SELECT
         j.key AS gate_type,
         SUM(CASE WHEN json_extract(j.value, '$.passed') = 1 THEN 1 ELSE 0 END) AS pass_count,
         SUM(CASE WHEN json_extract(j.value, '$.passed') = 0 THEN 1 ELSE 0 END) AS fail_count,
         COUNT(*) AS total
       FROM tasks, json_each(tasks.gate_results) AS j
       WHERE tasks.gate_results IS NOT NULL
         AND tasks.created_at >= ?
       GROUP BY j.key
       ORDER BY total DESC`,
      [since]
    );
  }

  retryStats(since: string): { total_retried: number; avg_retries: number; max_retries: number } {
    const row = this.get<{ total_retried: number; avg_retries: number; max_retries: number }>(
      `SELECT
         COUNT(*) AS total_retried,
         COALESCE(AVG(retry_count), 0) AS avg_retries,
         COALESCE(MAX(retry_count), 0) AS max_retries
       FROM tasks
       WHERE retry_count > 0
         AND created_at >= ?`,
      [since]
    );
    return row ?? { total_retried: 0, avg_retries: 0, max_retries: 0 };
  }

  taskTimeline(since: string): { task_id: string; title: string; tree_name: string | null; status: string; started_at: string; completed_at: string | null; cost_usd: number; current_step: string | null }[] {
    return this.all(
      `SELECT tk.id AS task_id, tk.title, t.name AS tree_name,
              tk.status, tk.started_at, tk.completed_at,
              tk.cost_usd, tk.current_step
       FROM tasks tk
       LEFT JOIN trees t ON tk.tree_id = t.id
       WHERE tk.started_at IS NOT NULL
         AND tk.started_at >= ?
       ORDER BY tk.started_at ASC`,
      [since]
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/db-analytics.test.ts`
Expected: ALL tests PASS (costByTree, costDaily, costTopTasks, gateAnalytics, retryStats, taskTimeline)

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/broker/db.ts tests/broker/db-analytics.test.ts
git commit -m "feat(analytics): add gateAnalytics, retryStats, taskTimeline DB methods (#40)"
```

---

### Task 3: Analytics API Endpoints

**Files:**
- Modify: `src/broker/server.ts:626-634` (before `GET /api/events` block)
- Test: `tests/broker/server-analytics.test.ts` (create)

- [ ] **Step 1: Write API endpoint tests**

Create `tests/broker/server-analytics.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-server-analytics.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

function insertTree(id: string, name: string) {
  db.treeUpsert({ id, name, path: `/code/${id}` });
}

function insertTask(
  id: string,
  treeId: string | null,
  opts: { status?: string; cost?: number; started_at?: string; completed_at?: string; gate_results?: string; retry_count?: number } = {}
) {
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, completed_at, gate_results, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, treeId, `Task ${id}`, opts.status ?? "completed",
      opts.cost ?? 0, opts.started_at ?? null, opts.completed_at ?? null,
      opts.gate_results ?? null, opts.retry_count ?? 0,
    ]
  );
}

describe("Analytics DB methods via API-like calls", () => {
  test("GET /api/analytics/cost returns bundled cost data", () => {
    insertTree("titan", "Titan");
    const now = new Date().toISOString();
    insertTask("W-001", "titan", { cost: 2.5, started_at: now });
    insertTask("W-002", "titan", { cost: 1.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const byTree = db.costByTree(since);
    const daily = db.costDaily(since);
    const topTasks = db.costTopTasks(since, 10);

    expect(byTree.length).toBe(1);
    expect(byTree[0].total_cost).toBe(3.5);
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(topTasks.length).toBe(2);
    expect(topTasks[0].cost_usd).toBeGreaterThanOrEqual(topTasks[1].cost_usd);
  });

  test("GET /api/analytics/gates returns gate + retry data", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", {
      started_at: now, retry_count: 1,
      gate_results: JSON.stringify({ tests: { passed: true }, lint: { passed: false } }),
    });

    const since = new Date(Date.now() - 86400000).toISOString();
    const gates = db.gateAnalytics(since);
    const retries = db.retryStats(since);

    expect(gates.length).toBe(2);
    expect(retries.total_retried).toBe(1);
  });

  test("GET /api/analytics/timeline returns task timeline", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { status: "active", started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const timeline = db.taskTimeline(since);
    expect(timeline.length).toBe(1);
    expect(timeline[0].task_id).toBe("W-001");
    expect(timeline[0].tree_name).toBe("T");
  });

  test("range conversion: 1h/4h/24h/7d to since timestamp", () => {
    const ranges: Record<string, number> = {
      "1h": 3600000,
      "4h": 14400000,
      "24h": 86400000,
      "7d": 604800000,
    };
    for (const [range, ms] of Object.entries(ranges)) {
      const since = new Date(Date.now() - ms).toISOString();
      expect(new Date(since).getTime()).toBeCloseTo(Date.now() - ms, -3);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (these test DB methods directly, which already exist)

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-analytics.test.ts`
Expected: PASS (these test the DB layer which is already implemented)

- [ ] **Step 3: Add analytics API routes to server.ts**

Add before the `// GET /api/events` block (around line 626) in `src/broker/server.ts`:

```typescript
    // GET /api/analytics/cost?range=1h|4h|24h|7d
    if (path === "/api/analytics/cost" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        by_tree: db.costByTree(since),
        daily: db.costDaily(since),
        top_tasks: db.costTopTasks(since, 10),
      });
    }

    // GET /api/analytics/gates?range=1h|4h|24h|7d
    if (path === "/api/analytics/gates" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        gates: db.gateAnalytics(since),
        retries: db.retryStats(since),
      });
    }

    // GET /api/analytics/timeline?range=1h|4h|24h|7d
    if (path === "/api/analytics/timeline" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        tasks: db.taskTimeline(since),
      });
    }
```

- [ ] **Step 4: Add the `rangeToSince` helper function**

Add after the `isAuthorized` function at the bottom of `src/broker/server.ts`:

```typescript
/** Convert a range string (1h, 4h, 24h, 7d) to an ISO since timestamp */
function rangeToSince(range: string): string {
  const ms: Record<string, number> = {
    "1h": 3600000,
    "4h": 14400000,
    "24h": 86400000,
    "7d": 604800000,
  };
  const offset = ms[range] ?? ms["24h"];
  return new Date(Date.now() - offset).toISOString();
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/broker/server.ts tests/broker/server-analytics.test.ts
git commit -m "feat(analytics): add /api/analytics/cost, gates, timeline endpoints (#40)"
```

---

### Task 4: useAnalytics Hook

**Files:**
- Create: `web/src/hooks/useAnalytics.ts`

- [ ] **Step 1: Create the useAnalytics hook**

Create `web/src/hooks/useAnalytics.ts`:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import type { WsMessage } from "./useWebSocket";
import { api } from "../api/client";

// ---- Types ----

export type TimeRange = "1h" | "4h" | "24h" | "7d";
export type DashboardTab = "overview" | "costs" | "gates";

export interface CostByTree {
  tree_name: string;
  tree_id: string;
  total_cost: number;
  task_count: number;
}

export interface CostDaily {
  date: string;
  total_cost: number;
  task_count: number;
}

export interface CostTopTask {
  task_id: string;
  title: string;
  tree_name: string | null;
  cost_usd: number;
}

export interface CostData {
  by_tree: CostByTree[];
  daily: CostDaily[];
  top_tasks: CostTopTask[];
}

export interface GateAnalytics {
  gate_type: string;
  pass_count: number;
  fail_count: number;
  total: number;
}

export interface RetryStats {
  total_retried: number;
  avg_retries: number;
  max_retries: number;
}

export interface GateData {
  gates: GateAnalytics[];
  retries: RetryStats;
}

export interface TimelineTask {
  task_id: string;
  title: string;
  tree_name: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number;
  current_step: string | null;
}

export interface TimelineData {
  tasks: TimelineTask[];
}

// WS event types that trigger a refresh in live mode
const LIVE_EVENTS = new Set(["task:status", "cost:updated", "gate:result", "task:created", "worker:ended"]);

function isLiveRange(range: TimeRange): boolean {
  return range === "1h" || range === "4h";
}

// ---- Hook ----

export function useAnalytics(
  range: TimeRange,
  activeTab: DashboardTab,
  wsMessages: WsMessage[],
) {
  const [costData, setCostData] = useState<CostData | null>(null);
  const [gateData, setGateData] = useState<GateData | null>(null);
  const [timelineData, setTimelineData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const lastWsMsgTs = useRef(0);

  const fetchTab = useCallback(async (tab: DashboardTab, r: TimeRange) => {
    setLoading(true);
    try {
      if (tab === "overview" || tab === "costs") {
        const data = await api<CostData>(`/api/analytics/cost?range=${r}`);
        setCostData(data);
      }
      if (tab === "overview" || tab === "gates") {
        const data = await api<GateData>(`/api/analytics/gates?range=${r}`);
        setGateData(data);
      }
      if (tab === "overview") {
        const data = await api<TimelineData>(`/api/analytics/timeline?range=${r}`);
        setTimelineData(data);
      }
    } catch {
      // API not available
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount, tab change, or range change
  useEffect(() => {
    fetchTab(activeTab, range);
  }, [activeTab, range, fetchTab]);

  // Live mode: re-fetch on relevant WS events
  useEffect(() => {
    if (!isLiveRange(range)) return;
    const latest = wsMessages[wsMessages.length - 1];
    if (!latest || latest.ts <= lastWsMsgTs.current) return;
    if (!LIVE_EVENTS.has(latest.type)) return;
    lastWsMsgTs.current = latest.ts;
    fetchTab(activeTab, range);
  }, [wsMessages, range, activeTab, fetchTab]);

  const refresh = useCallback(() => {
    fetchTab(activeTab, range);
  }, [activeTab, range, fetchTab]);

  return { costData, gateData, timelineData, loading, refresh };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useAnalytics.ts
git commit -m "feat(analytics): add useAnalytics hook with live/static refresh (#40)"
```

---

### Task 5: Dashboard Component — Structure, Tabs, KPI Cards

**Files:**
- Create: `web/src/components/Dashboard.tsx`

- [ ] **Step 1: Create Dashboard.tsx with tab strip, time range selector, and KPI cards**

Create `web/src/components/Dashboard.tsx`:

```tsx
import { useState } from "react";
import { useAnalytics, type TimeRange, type DashboardTab, type CostData, type GateData, type TimelineData, type TimelineTask, type GateAnalytics } from "../hooks/useAnalytics";
import type { WsMessage } from "../hooks/useWebSocket";
import type { Status } from "../hooks/useTasks";

interface Props {
  wsMessages: WsMessage[];
  status: Status | null;
}

export default function Dashboard({ wsMessages, status }: Props) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [range, setRange] = useState<TimeRange>("24h");
  const { costData, gateData, timelineData, loading, refresh } = useAnalytics(range, activeTab, wsMessages);

  const isLive = range === "1h" || range === "4h";

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 p-4">
      {/* Header: tabs + time range */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
        <TabStrip active={activeTab} onChange={setActiveTab} />
        <div className="flex items-center gap-2">
          {isLive && (
            <span className="text-[10px] text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              live
            </span>
          )}
          <TimeRangeSelector range={range} onChange={setRange} />
          {!isLive && (
            <button
              onClick={refresh}
              className="text-zinc-500 hover:text-zinc-300 text-sm px-1"
              title="Refresh"
            >
              &#x21bb;
            </button>
          )}
        </div>
      </div>

      {loading && !costData && !gateData && !timelineData ? (
        <div className="text-zinc-500 text-sm py-8 text-center">Loading analytics...</div>
      ) : (
        <>
          {activeTab === "overview" && (
            <OverviewTab costData={costData} gateData={gateData} timelineData={timelineData} status={status} range={range} />
          )}
          {activeTab === "costs" && (
            <CostsTab costData={costData} status={status} />
          )}
          {activeTab === "gates" && (
            <GatesTab gateData={gateData} />
          )}
        </>
      )}
    </div>
  );
}

// ---- Tab Strip ----

function TabStrip({ active, onChange }: { active: DashboardTab; onChange: (t: DashboardTab) => void }) {
  const tabs: { id: DashboardTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "costs", label: "Costs" },
    { id: "gates", label: "Gates" },
  ];
  return (
    <div className="flex gap-0.5 bg-zinc-800 rounded-md p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            active === tab.id
              ? "bg-emerald-600 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---- Time Range Selector ----

function TimeRangeSelector({ range, onChange }: { range: TimeRange; onChange: (r: TimeRange) => void }) {
  const ranges: TimeRange[] = ["1h", "4h", "24h", "7d"];
  return (
    <div className="flex gap-0.5 bg-zinc-800 rounded-md p-0.5">
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            range === r
              ? "bg-emerald-600 text-white"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// ---- KPI Cards ----

function KpiCards({ costData, gateData, status }: { costData?: CostData | null; gateData?: GateData | null; status?: Status | null }) {
  const todayCost = status?.cost.today ?? 0;
  const weekCost = status?.cost.week ?? 0;
  const taskCount = status?.tasks.total ?? 0;
  const activeCount = status?.tasks.active ?? 0;

  const totalGates = gateData?.gates.reduce((sum, g) => sum + g.total, 0) ?? 0;
  const passedGates = gateData?.gates.reduce((sum, g) => sum + g.pass_count, 0) ?? 0;
  const passRate = totalGates > 0 ? Math.round((passedGates / totalGates) * 100) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      <KpiCard label="Today's Spend" value={`$${todayCost.toFixed(2)}`} sub={status ? `of $${25} budget` : undefined} />
      <KpiCard label="Week's Spend" value={`$${weekCost.toFixed(2)}`} sub={status ? `of $${100} budget` : undefined} />
      <KpiCard label="Tasks" value={String(taskCount)} sub={activeCount > 0 ? `${activeCount} active` : undefined} accent={activeCount > 0 ? "cyan" : undefined} />
      <KpiCard label="Gate Pass Rate" value={totalGates > 0 ? `${passRate}%` : "—"} sub={totalGates > 0 ? `${passedGates}/${totalGates} passed` : "no data"} />
    </div>
  );
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "cyan" }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3">
      <div className="text-[10px] text-zinc-500 mb-1">{label}</div>
      <div className="text-xl font-bold text-emerald-400">{value}</div>
      {sub && <div className={`text-[10px] ${accent === "cyan" ? "text-cyan-400" : "text-zinc-600"}`}>{sub}</div>}
    </div>
  );
}

// ---- Overview Tab ----

function OverviewTab({ costData, gateData, timelineData, status, range }: {
  costData: CostData | null; gateData: GateData | null; timelineData: TimelineData | null; status: Status | null; range: TimeRange;
}) {
  return (
    <>
      <KpiCards costData={costData} gateData={gateData} status={status} />
      <GanttTimeline tasks={timelineData?.tasks ?? []} range={range} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <CostByTree data={costData?.by_tree ?? []} />
        <GatePassRates gates={gateData?.gates ?? []} retries={gateData?.retries} />
      </div>
    </>
  );
}

// ---- Costs Tab ----

function CostsTab({ costData, status }: { costData: CostData | null; status: Status | null }) {
  return (
    <>
      <KpiCards costData={costData} status={status} />
      <CostByTree data={costData?.by_tree ?? []} />
      <div className="mt-3">
        <CostDaily data={costData?.daily ?? []} />
      </div>
      <div className="mt-3">
        <CostTopTasks data={costData?.top_tasks ?? []} />
      </div>
    </>
  );
}

// ---- Gates Tab ----

function GatesTab({ gateData }: { gateData: GateData | null }) {
  const totalGates = gateData?.gates.reduce((sum, g) => sum + g.total, 0) ?? 0;
  const passedGates = gateData?.gates.reduce((sum, g) => sum + g.pass_count, 0) ?? 0;
  const passRate = totalGates > 0 ? Math.round((passedGates / totalGates) * 100) : 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <KpiCard label="Gate Pass Rate" value={totalGates > 0 ? `${passRate}%` : "—"} sub={totalGates > 0 ? `${passedGates}/${totalGates} passed` : "no data"} />
        <KpiCard label="Retry Rate" value={String(gateData?.retries.total_retried ?? 0)} sub={`avg ${(gateData?.retries.avg_retries ?? 0).toFixed(1)} retries`} />
      </div>
      <GatePassRates gates={gateData?.gates ?? []} retries={gateData?.retries} />
      <div className="mt-3">
        <RetryStats retries={gateData?.retries ?? null} />
      </div>
    </>
  );
}

// ---- Gantt Timeline ----

function GanttTimeline({ tasks, range }: { tasks: TimelineTask[]; range: TimeRange }) {
  if (tasks.length === 0) {
    return (
      <Panel title="Timeline">
        <div className="text-zinc-600 text-xs py-4 text-center">No task activity in this time range</div>
      </Panel>
    );
  }

  const rangeMs: Record<TimeRange, number> = { "1h": 3600000, "4h": 14400000, "24h": 86400000, "7d": 604800000 };
  const now = Date.now();
  const rangeStart = now - rangeMs[range];

  // Generate time axis labels
  const labelCount = range === "1h" ? 4 : range === "4h" ? 4 : range === "24h" ? 6 : 7;
  const labels: string[] = [];
  for (let i = 0; i <= labelCount; i++) {
    const t = new Date(rangeStart + (rangeMs[range] / labelCount) * i);
    labels.push(range === "7d"
      ? t.toLocaleDateString(undefined, { weekday: "short" })
      : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  }

  const statusColor: Record<string, string> = {
    completed: "bg-emerald-500",
    failed: "bg-red-500",
    active: "bg-blue-500",
    queued: "bg-cyan-500",
    draft: "bg-zinc-600",
  };

  return (
    <Panel title="Timeline">
      {/* Time axis */}
      <div className="flex justify-between text-[9px] text-zinc-600 mb-1 pl-24">
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
      {/* Task rows */}
      <div className="space-y-1">
        {tasks.map((task) => {
          const start = new Date(task.started_at).getTime();
          const end = task.completed_at ? new Date(task.completed_at).getTime() : now;
          const leftPct = Math.max(0, ((start - rangeStart) / rangeMs[range]) * 100);
          const widthPct = Math.max(1, ((end - start) / rangeMs[range]) * 100);

          return (
            <div key={task.task_id} className="flex items-center h-5">
              <div className="w-24 text-[10px] text-zinc-400 truncate pr-2" title={task.title}>
                {task.title}
              </div>
              <div className="flex-1 relative h-4">
                <div
                  className={`absolute h-full rounded-sm ${statusColor[task.status] ?? "bg-zinc-600"} opacity-85 group`}
                  style={{ left: `${leftPct}%`, width: `${Math.min(widthPct, 100 - leftPct)}%` }}
                  title={`${task.title} — ${task.status} — $${task.cost_usd.toFixed(2)}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ---- Cost by Tree ----

function CostByTree({ data }: { data: CostData["by_tree"] }) {
  if (data.length === 0) {
    return (
      <Panel title="Cost by Tree">
        <div className="text-zinc-600 text-xs py-2 text-center">No cost data</div>
      </Panel>
    );
  }
  const maxCost = Math.max(...data.map(d => d.total_cost));

  return (
    <Panel title="Cost by Tree">
      <div className="space-y-2">
        {data.map((item) => (
          <div key={item.tree_id}>
            <div className="flex justify-between text-[10px] mb-0.5">
              <span className="text-zinc-400">{item.tree_name}</span>
              <span className="text-emerald-400">${item.total_cost.toFixed(2)}</span>
            </div>
            <div className="bg-zinc-800 h-2 rounded-full overflow-hidden">
              <div
                className="bg-emerald-600 h-full rounded-full transition-all"
                style={{ width: `${(item.total_cost / maxCost) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---- Cost Daily ----

function CostDaily({ data }: { data: CostData["daily"] }) {
  if (data.length === 0) return null;
  const maxCost = Math.max(...data.map(d => d.total_cost));

  return (
    <Panel title="Daily Spend">
      <div className="flex items-end gap-1 h-24">
        {data.map((day) => (
          <div key={day.date} className="flex-1 flex flex-col items-center">
            <div
              className="w-full bg-emerald-600 rounded-t transition-all"
              style={{ height: `${maxCost > 0 ? (day.total_cost / maxCost) * 100 : 0}%` }}
              title={`${day.date}: $${day.total_cost.toFixed(2)} (${day.task_count} tasks)`}
            />
            <div className="text-[8px] text-zinc-600 mt-1">{day.date.slice(5)}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---- Cost Top Tasks ----

function CostTopTasks({ data }: { data: CostData["top_tasks"] }) {
  if (data.length === 0) return null;

  return (
    <Panel title="Top Tasks by Cost">
      <div className="space-y-1">
        {data.map((task) => (
          <div key={task.task_id} className="flex justify-between text-[11px]">
            <span className="text-zinc-400 truncate mr-2">{task.task_id} {task.title}</span>
            <span className="text-emerald-400 flex-shrink-0">${task.cost_usd.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---- Gate Pass Rates ----

function GatePassRates({ gates, retries }: { gates: GateAnalytics[]; retries?: GateData["retries"] | null }) {
  if (gates.length === 0) {
    return (
      <Panel title="Gate Pass Rates">
        <div className="text-zinc-600 text-xs py-2 text-center">No gate results recorded yet</div>
      </Panel>
    );
  }

  return (
    <Panel title="Gate Pass Rates">
      <div className="space-y-2">
        {gates.map((gate) => {
          const pct = gate.total > 0 ? Math.round((gate.pass_count / gate.total) * 100) : 0;
          return (
            <div key={gate.gate_type}>
              <div className="flex justify-between text-[10px] mb-0.5">
                <span className="text-zinc-400">{gate.gate_type}</span>
                <span className="text-zinc-500">{pct}% <span className="text-zinc-600">({gate.pass_count}/{gate.total})</span></span>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden">
                {gate.pass_count > 0 && (
                  <div className="bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                )}
                {gate.fail_count > 0 && (
                  <div className="bg-red-500 transition-all" style={{ width: `${100 - pct}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {retries && retries.total_retried > 0 && (
        <div className="mt-3 pt-2 border-t border-zinc-800 text-[10px] text-zinc-500">
          {retries.total_retried} tasks retried · avg {retries.avg_retries.toFixed(1)} retries · max {retries.max_retries}
        </div>
      )}
    </Panel>
  );
}

// ---- Retry Stats (expanded, Gates tab only) ----

function RetryStats({ retries }: { retries: GateData["retries"] | null }) {
  if (!retries || retries.total_retried === 0) {
    return (
      <Panel title="Retry Statistics">
        <div className="text-zinc-600 text-xs py-2 text-center">No retries recorded</div>
      </Panel>
    );
  }

  return (
    <Panel title="Retry Statistics">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-lg font-bold text-emerald-400">{retries.total_retried}</div>
          <div className="text-[10px] text-zinc-500">Tasks Retried</div>
        </div>
        <div>
          <div className="text-lg font-bold text-emerald-400">{retries.avg_retries.toFixed(1)}</div>
          <div className="text-[10px] text-zinc-500">Avg Retries</div>
        </div>
        <div>
          <div className="text-lg font-bold text-emerald-400">{retries.max_retries}</div>
          <div className="text-[10px] text-zinc-500">Max Retries</div>
        </div>
      </div>
    </Panel>
  );
}

// ---- Shared Panel wrapper ----

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 font-semibold mb-2">{title}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit`
Expected: No errors (or may fail on App.tsx not yet importing Dashboard — that's Task 6)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Dashboard.tsx
git commit -m "feat(analytics): add Dashboard component with tabs, KPIs, Gantt, charts (#40)"
```

---

### Task 6: Route Integration — App.tsx and Sidebar.tsx

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Sidebar.tsx`

- [ ] **Step 1: Update App.tsx — add dashboard view type, import, state, and rendering**

In `web/src/App.tsx`:

1. Add import:
```typescript
import Dashboard from "./components/Dashboard";
```

2. Change the View type:
```typescript
type View = "tasks" | "settings" | "dashboard";
```

3. Add `wsMessages` state tracking. After the `lastWsMsg` state (line 66), add:
```typescript
const [wsMessages, setWsMessages] = useState<WsMessage[]>([]);
```

4. In the `onMessage` callback (line 69), add after `setLastWsMsg(msg)`:
```typescript
setWsMessages(prev => [...prev.slice(-50), msg]);
```

5. Add `onDashboardClick` to Sidebar props in both mobile and desktop renders.

6. In the desktop center panel (around line 186), change the render to:
```tsx
{view === "tasks" ? (
  <TaskList ... />
) : view === "dashboard" ? (
  <Dashboard wsMessages={wsMessages} status={taskState.status} />
) : (
  <Settings ... />
)}
```

7. Apply the same pattern to the mobile `mobileTab === "tasks"` section.

- [ ] **Step 2: Update Sidebar.tsx — add Dashboard button and prop**

In `web/src/components/Sidebar.tsx`:

1. Add `onDashboardClick` to the Props interface:
```typescript
interface Props {
  trees: Tree[];
  status: Status | null;
  taskCount: number;
  selectedTree: string | null;
  onSelectTree: (id: string | null) => void;
  connected: boolean;
  onSettingsClick: () => void;
  onDashboardClick: () => void;
}
```

2. Add to the destructured props:
```typescript
export default function Sidebar({ trees, status, taskCount, selectedTree, onSelectTree, connected, onSettingsClick, onDashboardClick }: Props) {
```

3. Add Dashboard button after the "All Tasks" button (after line 49, before the tree groups):
```tsx
<button
  onClick={onDashboardClick}
  className="w-full text-left px-2 py-1.5 rounded text-sm text-zinc-400 hover:text-zinc-200 mb-4 flex items-center gap-2"
>
  <svg width="14" height="14" viewBox="0 0 14 14" className="flex-shrink-0">
    <rect x="1" y="8" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.6" />
    <rect x="5.5" y="4" width="3" height="9" rx="0.5" fill="currentColor" opacity="0.8" />
    <rect x="10" y="1" width="3" height="12" rx="0.5" fill="currentColor" />
  </svg>
  <span>Dashboard</span>
</button>
```

- [ ] **Step 3: Wire props in App.tsx**

Pass `onDashboardClick` to both Sidebar instances in App.tsx:

```tsx
onDashboardClick={() => { setView("dashboard"); }}
```

For the mobile instance, also set the mobile tab:
```tsx
onDashboardClick={() => { setView("dashboard"); setMobileTab("tasks"); }}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Build the web frontend**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npm run build`
Expected: Build succeeds

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx web/src/components/Sidebar.tsx
git commit -m "feat(analytics): integrate Dashboard into App routing and Sidebar (#40)"
```

---

### Task 7: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript check**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx tsc --noEmit`
Expected: Clean — zero errors

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass (existing + new analytics tests)

- [ ] **Step 3: Build web frontend**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npm run build`
Expected: Build succeeds, output in `web/dist/`

- [ ] **Step 4: Visual smoke test (if broker is running)**

Start Grove and open the web UI. Click "Dashboard" in sidebar. Verify:
- Tab strip renders (Overview / Costs / Gates)
- Time range selector renders (1h / 4h / 24h / 7d)
- KPI cards show (may be $0.00 / 0 tasks with empty DB — that's correct)
- Switching tabs works
- Empty states render cleanly

- [ ] **Step 5: Verify acceptance criteria from issue #40**

- [x] Dashboard shows timeline with task bars (GanttTimeline component)
- [x] Cost by tree with proportional bars (CostByTree component)
- [x] Gate pass/fail rates (GatePassRates component)
- [x] Time range selector 1h/4h/24h/7d (TimeRangeSelector component)
- [x] Auto-refreshes via WebSocket (useAnalytics live mode for 1h/4h ranges)
- [x] TypeScript compiles clean (tsc --noEmit)
