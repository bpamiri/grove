# T9: Observability Dashboard Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the dashboard with per-worker activity timelines, task execution breakdown, worker utilization chart, and a filterable event log viewer — all powered by SAP events.

**Architecture:** New analytics DB queries provide timeline, step-duration, and utilization data. New React components render visualizations. SAP events are persisted to the events table for the event log viewer. Dashboard gets new tabs.

**Tech Stack:** Bun, TypeScript, React, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T9 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/broker/db.ts` | New analytics queries (timeline, utilization, step durations) |
| Create | `tests/broker/db-observability.test.ts` | Analytics query tests |
| Modify | `src/broker/server.ts` | New analytics endpoints, SAP event persistence |
| Create | `web/src/components/ActivityTimeline.tsx` | Horizontal worker timeline bars |
| Create | `web/src/components/TaskBreakdown.tsx` | Per-task step duration breakdown |
| Create | `web/src/components/WorkerUtilization.tsx` | Worker capacity chart |
| Create | `web/src/components/EventLogViewer.tsx` | Filterable SAP event table |
| Modify | `web/src/components/Dashboard.tsx` | Add new tabs, wire components |

---

### Task 1: Analytics DB Queries

**Files:** Modify `src/broker/db.ts`, Create `tests/broker/db-observability.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/broker/db-observability.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-observability.db");
let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);

  // Seed test data
  db.treeUpsert({ id: "app", name: "App", path: "/app", github: null, branch_prefix: "grove/", config: "{}" });
  db.run("INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, completed_at, current_step) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now'), ?)",
    ["W-001", "app", "Add auth", "completed", 1.50, "implement"]);
  db.run("INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, current_step) VALUES (?, ?, ?, ?, ?, datetime('now', '-10 minutes'), ?)",
    ["W-002", "app", "Fix bug", "active", 0.30, "plan"]);
});

afterEach(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) { const f = TEST_DB + s; if (existsSync(f)) unlinkSync(f); }
});

describe("observability queries", () => {
  test("taskActivityTimeline returns tasks with timing", () => {
    const timeline = db.taskActivityTimeline("24h");
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    const w1 = timeline.find((t: any) => t.task_id === "W-001");
    expect(w1).toBeDefined();
    expect(w1!.status).toBe("completed");
  });

  test("workerUtilization returns bucketed data", () => {
    // Add sessions to count workers
    db.sessionCreate("s1", "W-001", "worker", 123);
    db.sessionEnd("s1", "completed");
    db.sessionCreate("s2", "W-002", "worker", 456);

    const utilization = db.workerUtilization("1h");
    expect(utilization.length).toBeGreaterThanOrEqual(0);
  });

  test("filteredEvents returns events matching criteria", () => {
    db.addEvent("W-001", null, "agent:tool_use", "Read src/a.ts");
    db.addEvent("W-001", null, "agent:thinking", "Analyzing...");
    db.addEvent("W-002", null, "agent:tool_use", "Edit src/b.ts");

    const all = db.filteredEvents({ since: "1h" });
    expect(all.length).toBeGreaterThanOrEqual(3);

    const w1Only = db.filteredEvents({ taskId: "W-001", since: "1h" });
    expect(w1Only.length).toBe(2);

    const toolOnly = db.filteredEvents({ eventType: "agent:tool_use", since: "1h" });
    expect(toolOnly.length).toBe(2);
  });
});
```

- [ ] **Step 2: Implement analytics queries**

In `src/broker/db.ts`, add methods:

```typescript
  /** Activity timeline: tasks with start/end/step/cost for timeline rendering */
  taskActivityTimeline(since: string): any[] {
    const sinceDate = this.sinceToDate(since);
    return this.all(
      `SELECT t.id as task_id, t.title, t.tree_id, t.status, t.started_at, t.completed_at,
              t.cost_usd, t.current_step, t.step_index
       FROM tasks t
       WHERE t.started_at IS NOT NULL AND t.started_at >= ?
       ORDER BY t.started_at DESC`,
      [sinceDate],
    );
  }

  /** Worker utilization: count of active sessions bucketed by 5-min intervals */
  workerUtilization(since: string): any[] {
    const sinceDate = this.sinceToDate(since);
    return this.all(
      `SELECT strftime('%Y-%m-%d %H:%M', started_at, 'start of minute', printf('-%d minutes', CAST(strftime('%M', started_at) AS INTEGER) % 5)) as bucket,
              COUNT(*) as active_workers
       FROM sessions
       WHERE role = 'worker' AND started_at >= ?
       GROUP BY bucket
       ORDER BY bucket`,
      [sinceDate],
    );
  }

  /** Filtered events for event log viewer */
  filteredEvents(opts: { taskId?: string; eventType?: string; since?: string; limit?: number }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.taskId) { conditions.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.eventType) { conditions.push("event_type = ?"); params.push(opts.eventType); }
    if (opts.since) { conditions.push("created_at >= ?"); params.push(this.sinceToDate(opts.since)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;

    return this.all(
      `SELECT id, task_id, session_id, event_type, summary, detail, created_at
       FROM events ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, limit],
    );
  }

  /** Convert "1h", "4h", "24h", "7d" to ISO date string */
  private sinceToDate(since: string): string {
    const now = new Date();
    const match = since.match(/^(\d+)(h|d)$/);
    if (!match) return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [, num, unit] = match;
    const ms = unit === "h" ? Number(num) * 60 * 60 * 1000 : Number(num) * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() - ms).toISOString();
  }
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/broker/db-observability.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/broker/db.ts tests/broker/db-observability.test.ts
git commit -m "feat: add observability analytics queries"
```

---

### Task 2: Analytics API Endpoints + Event Persistence

**Files:** Modify `src/broker/server.ts`

- [ ] **Step 1: Add new analytics endpoints**

In `src/broker/server.ts`, find the existing `/api/analytics/` endpoints and add alongside them:

```typescript
    // GET /api/analytics/timeline — activity timeline
    if (path === "/api/analytics/timeline" && req.method === "GET") {
      const range = new URL(req.url).searchParams.get("range") ?? "24h";
      return json(db.taskActivityTimeline(range));
    }

    // GET /api/analytics/utilization — worker utilization
    if (path === "/api/analytics/utilization" && req.method === "GET") {
      const range = new URL(req.url).searchParams.get("range") ?? "24h";
      return json(db.workerUtilization(range));
    }

    // GET /api/analytics/events — filtered event log
    if (path === "/api/analytics/events" && req.method === "GET") {
      const params = new URL(req.url).searchParams;
      return json(db.filteredEvents({
        taskId: params.get("task") ?? undefined,
        eventType: params.get("type") ?? undefined,
        since: params.get("since") ?? "24h",
        limit: Number(params.get("limit") ?? 200),
      }));
    }
```

- [ ] **Step 2: Add SAP event persistence**

In `wireEventBus()`, after the SAP event forwarding, add persistence for key SAP events:

```typescript
  // Persist SAP activity events for observability dashboard
  bus.on("agent:tool_use", (data) => {
    db.addEvent(data.taskId, data.agentId, "agent:tool_use", `${data.tool}: ${data.input}`);
  });
  bus.on("agent:thinking", (data) => {
    db.addEvent(data.taskId, data.agentId, "agent:thinking", data.snippet);
  });
```

Note: Only persist tool_use and thinking (not every text event — too noisy).

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: add observability API endpoints and SAP event persistence"
```

---

### Task 3: Dashboard Components

**Files:** Create 4 new components, Modify `web/src/components/Dashboard.tsx`

- [ ] **Step 1: Create ActivityTimeline component**

Create `web/src/components/ActivityTimeline.tsx`:

```tsx
import { useMemo } from "react";

interface TimelineEntry {
  task_id: string;
  title: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number;
  current_step: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  queued: "bg-zinc-500",
};

export default function ActivityTimeline({ data, rangeMs }: { data: TimelineEntry[]; rangeMs: number }) {
  const now = Date.now();
  const start = now - rangeMs;

  const bars = useMemo(() =>
    data
      .filter(t => t.started_at)
      .map(t => {
        const s = new Date(t.started_at).getTime();
        const e = t.completed_at ? new Date(t.completed_at).getTime() : now;
        const left = Math.max(0, ((s - start) / rangeMs) * 100);
        const width = Math.min(100 - left, ((e - s) / rangeMs) * 100);
        const durationSec = Math.floor((e - s) / 1000);
        const durationStr = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
        return { ...t, left, width, durationStr };
      })
      .filter(b => b.width > 0),
  [data, rangeMs, now]);

  if (bars.length === 0) return <div className="text-zinc-500 text-xs p-4">No activity in this range</div>;

  return (
    <div className="space-y-1.5">
      {bars.map(b => (
        <div key={b.task_id} className="flex items-center gap-2 text-xs">
          <span className="text-zinc-400 w-16 flex-shrink-0 truncate font-mono">{b.task_id}</span>
          <div className="flex-1 h-5 bg-zinc-900 rounded relative overflow-hidden">
            <div
              className={`absolute h-full rounded ${STATUS_COLORS[b.status] ?? "bg-zinc-600"} opacity-80`}
              style={{ left: `${b.left}%`, width: `${Math.max(b.width, 1)}%` }}
            />
            <span className="absolute inset-0 flex items-center px-2 text-[10px] text-white/80 truncate">
              {b.current_step} ({b.durationStr})
            </span>
          </div>
          <span className="text-zinc-500 w-14 text-right">${b.cost_usd.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create TaskBreakdown component**

Create `web/src/components/TaskBreakdown.tsx`:

```tsx
interface StepDuration {
  step: string;
  durationMs: number;
  type: string;
}

const TYPE_COLORS: Record<string, string> = {
  worker: "bg-blue-500",
  gate: "bg-amber-500",
  merge: "bg-emerald-500",
  review: "bg-purple-500",
  verdict: "bg-zinc-500",
};

export default function TaskBreakdown({ steps, totalCost }: { steps: StepDuration[]; totalCost: number }) {
  const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
  if (totalMs === 0) return <div className="text-zinc-500 text-xs">No step data</div>;

  return (
    <div className="space-y-1">
      {steps.map((s, i) => {
        const pct = (s.durationMs / totalMs) * 100;
        const sec = Math.floor(s.durationMs / 1000);
        const label = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="text-zinc-400 w-20 truncate">{s.step}</span>
            <div className="flex-1 h-4 bg-zinc-900 rounded overflow-hidden">
              <div className={`h-full ${TYPE_COLORS[s.type] ?? "bg-zinc-600"} rounded`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-zinc-500 w-12 text-right">{label}</span>
          </div>
        );
      })}
      <div className="text-zinc-500 text-[10px] text-right mt-1">
        Total: {Math.floor(totalMs / 1000)}s | ${totalCost.toFixed(2)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create WorkerUtilization component**

Create `web/src/components/WorkerUtilization.tsx`:

```tsx
interface UtilizationBucket {
  bucket: string;
  active_workers: number;
}

export default function WorkerUtilization({ data, maxWorkers }: { data: UtilizationBucket[]; maxWorkers: number }) {
  if (data.length === 0) return <div className="text-zinc-500 text-xs p-4">No utilization data</div>;

  const max = Math.max(maxWorkers, ...data.map(d => d.active_workers));

  return (
    <div className="flex items-end gap-0.5 h-24">
      {data.map((d, i) => {
        const pct = (d.active_workers / max) * 100;
        const full = d.active_workers >= maxWorkers;
        return (
          <div
            key={i}
            className={`flex-1 rounded-t ${full ? "bg-amber-500" : "bg-blue-500"} opacity-70`}
            style={{ height: `${pct}%`, minHeight: d.active_workers > 0 ? "4px" : "0" }}
            title={`${d.bucket}: ${d.active_workers} workers`}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Create EventLogViewer component**

Create `web/src/components/EventLogViewer.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

interface EventEntry {
  id: number;
  task_id: string | null;
  event_type: string;
  summary: string | null;
  created_at: string;
}

export default function EventLogViewer() {
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [taskFilter, setTaskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [since, setSince] = useState("1h");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ since });
    if (taskFilter) params.set("task", taskFilter);
    if (typeFilter) params.set("type", typeFilter);
    try {
      const data = await api<EventEntry[]>(`/api/analytics/events?${params}`);
      setEvents(data);
    } catch {}
  }, [taskFilter, typeFilter, since]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex gap-2 mb-2 text-xs">
        <input
          value={taskFilter}
          onChange={e => setTaskFilter(e.target.value)}
          placeholder="Task ID"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-24 text-zinc-300 focus:outline-none"
        />
        <input
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          placeholder="Event type"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-32 text-zinc-300 focus:outline-none"
        />
        <select value={since} onChange={e => setSince(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300">
          <option value="1h">1h</option>
          <option value="4h">4h</option>
          <option value="24h">24h</option>
          <option value="7d">7d</option>
        </select>
        <button onClick={load} className="px-2 py-1 bg-zinc-700 rounded text-zinc-300 hover:bg-zinc-600">Refresh</button>
      </div>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg max-h-64 overflow-y-auto font-mono text-[11px]">
        {events.length === 0 ? (
          <div className="text-zinc-500 p-4 text-center">No events</div>
        ) : events.map(e => (
          <div key={e.id} className="flex gap-2 px-2 py-0.5 hover:bg-zinc-900/50 border-b border-zinc-800/50">
            <span className="text-zinc-600 flex-shrink-0">{new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="text-blue-400 flex-shrink-0 w-28 truncate">{e.event_type}</span>
            <span className="text-zinc-400 flex-shrink-0 w-14">{e.task_id ?? ""}</span>
            <span className="text-zinc-300 truncate">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire into Dashboard**

In `web/src/components/Dashboard.tsx`, add imports for the new components and add new tabs ("activity", "events") alongside existing "overview" and "costs" tabs. Wire the components with data from the analytics endpoints.

The existing Dashboard already has a tab system and data fetching. Add the new tabs and components following the existing pattern (useAnalytics hook or direct fetch).

- [ ] **Step 6: Build web**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ src/broker/server.ts
git commit -m "feat: add observability dashboard components — timeline, utilization, event log"
```
