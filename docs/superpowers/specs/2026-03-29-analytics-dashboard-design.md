# Analytics Dashboard Design

**Issue:** #40 — Analytics dashboard: timeline, cost charts, gate analytics in web GUI
**Date:** 2026-03-29

## Overview

Add an analytics dashboard to Grove's web GUI with three tabbed views (Overview, Costs, Gates), powered by SQL aggregation over existing tables. No schema changes. Real-time updates via existing WebSocket events for short time ranges; static snapshots for longer ranges.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data computation | SQL aggregation in DB layer | Grove's scale (hundreds–low thousands of tasks) makes this simple and fast. No materialized tables needed. |
| Layout | KPI cards + panels below | At-a-glance summary on Overview; dedicated tabs go deeper. |
| View switching | Tab strip within dashboard | One sidebar entry ("Dashboard"), tabs for Overview/Costs/Gates. Keeps sidebar clean. |
| Timeline visualization | Gantt-style horizontal bars | Shows concurrency, duration, and failure clustering. Maps directly to `started_at`/`completed_at` data. |
| Gate analytics | Aggregated only | Per-task gate results already visible in TaskDetail. Dashboard provides bird's-eye pass/fail rates. |
| Real-time updates | Live for 1h/4h, static for 24h/7d | Live when actively watching; static snapshot for historical review. |
| Charting | CSS-only (div width percentages) | No charting library dependency per issue constraint. |

## 1. Analytics DB Methods

Six new methods on the `Database` class in `src/broker/db.ts`. All query existing tables — no schema changes.

### `costByTree(since: string)`

Returns `{ tree_name: string, tree_id: number, total_cost: number, task_count: number }[]`

JOIN tasks → trees, SUM `cost_usd`, GROUP BY tree. Filtered by `created_at >= since`.

### `costDaily(since: string)`

Returns `{ date: string, total_cost: number, task_count: number }[]`

GROUP BY `date(created_at)`, filtered by `created_at >= since`. For the `/cost` endpoint, the API converts range to `since` like all other methods.

### `costTopTasks(since: string, limit: number)`

Returns `{ task_id: number, title: string, tree_name: string, cost_usd: number }[]`

Tasks ordered by `cost_usd` DESC, top N, joined with trees for name.

### `gateAnalytics(since: string)`

Returns `{ gate_type: string, pass_count: number, fail_count: number, total: number }[]`

Parses `gate_results` JSON column from completed/failed tasks using SQLite `json_each()`. Aggregates pass/fail counts per gate type.

### `retryStats(since: string)`

Returns `{ total_retried: number, avg_retries: number, max_retries: number }`

Filters tasks where `retry_count > 0`, computes aggregate stats.

### `taskTimeline(since: string)`

Returns `{ task_id: number, title: string, tree_name: string, status: string, started_at: string, completed_at: string | null, cost_usd: number, current_step: string | null }[]`

Tasks with `started_at` in range, joined with trees, ordered by `started_at`.

**`since` parameter:** ISO timestamp string, computed from time range by the API layer.

## 2. API Endpoints

Three new endpoints in `src/broker/server.ts`, following existing route-matching pattern.

### `GET /api/analytics/cost?range=1h|4h|24h|7d`

Response:
```json
{
  "by_tree": [{ "tree_name": "titan", "tree_id": 1, "total_cost": 8.2, "task_count": 5 }],
  "daily": [{ "date": "2026-03-29", "total_cost": 2.4, "task_count": 3 }],
  "top_tasks": [{ "task_id": 1, "title": "fix auth", "tree_name": "titan", "cost_usd": 1.5 }]
}
```

### `GET /api/analytics/gates?range=1h|4h|24h|7d`

Response:
```json
{
  "gates": [{ "gate_type": "tests", "pass_count": 17, "fail_count": 3, "total": 20 }],
  "retries": { "total_retried": 4, "avg_retries": 1.5, "max_retries": 3 }
}
```

### `GET /api/analytics/timeline?range=1h|4h|24h|7d`

Response:
```json
{
  "tasks": [{
    "task_id": 1, "title": "fix auth", "tree_name": "titan",
    "status": "completed", "started_at": "...", "completed_at": "...",
    "cost_usd": 1.5, "current_step": "evaluate"
  }]
}
```

**Design notes:**
- One call per tab: Overview calls all three; Costs calls `/cost`; Gates calls `/gates`.
- `range` is converted to `since` timestamp server-side.
- No pagination — bounded time ranges produce small result sets.
- No new WebSocket events needed; frontend re-fetches on existing events.

## 3. Frontend Hook

New file: `web/src/hooks/useAnalytics.ts`

### Interface

```typescript
function useAnalytics(
  range: TimeRange,
  activeTab: DashboardTab,
  wsMessages: WsMessage[]
): {
  costData: CostData | null;
  gateData: GateData | null;
  timelineData: TimelineData | null;
  loading: boolean;
  refresh: () => void;
}

type TimeRange = '1h' | '4h' | '24h' | '7d';
type DashboardTab = 'overview' | 'costs' | 'gates';
```

### Behavior

- **Lazy fetching by tab:** Overview fetches all three endpoints; Costs/Gates fetch only their own.
- **Live mode (1h, 4h):** Re-fetches active tab data when WebSocket delivers `task:status`, `cost:updated`, or `gate:result` events.
- **Static mode (24h, 7d):** Fetches once on mount/range change. Manual refresh via `refresh()`.
- **Range change:** Fresh fetch, no caching between ranges.
- **Follows existing patterns:** Same structure as `useTasks` — state + fetch + WS message listener.

## 4. Dashboard Component

New file: `web/src/components/Dashboard.tsx` — single file with subcomponents.

### Subcomponents

| Component | Purpose |
|-----------|---------|
| `TabStrip` | Overview \| Costs \| Gates toggle |
| `TimeRangeSelector` | 1h \| 4h \| 24h \| 7d + refresh button |
| `KpiCards` | Today spend, week spend, task count, gate pass rate |
| `GanttTimeline` | Horizontal task bars positioned by time, color-coded by status |
| `CostByTree` | Horizontal bars with tree name + dollar amount |
| `CostDaily` | Daily spend bars (Costs tab only) |
| `CostTopTasks` | Top tasks by cost as a simple table (Costs tab only) |
| `GatePassRates` | Stacked pass/fail bars per gate type with counts |
| `RetryStats` | Summary line: total retried, avg retries, max retries |

### Tab Layouts

**Overview:** KpiCards → GanttTimeline → [CostByTree | GatePassRates] side by side

**Costs:** KpiCards (cost-only: today, week) → CostByTree (full width) → CostDaily → CostTopTasks

**Gates:** KpiCards (gates-only: pass rate, retry rate) → GatePassRates (full width) → RetryStats (expanded)

### Styling

- Dark theme: `bg-zinc-950` page, `bg-zinc-900/50` cards, `border-zinc-800`
- Status colors: emerald (completed), red (failed), blue (active), cyan (queued)
- Cost bars: emerald
- Gate bars: emerald (pass) / red (fail) stacked
- Gantt bars: color-coded by task status
- Mobile: KPI cards → 2x2 grid, side-by-side panels → stacked vertically

### Gantt Timeline Detail

- Time axis across top, derived from range (e.g., hourly marks for 24h view)
- Each task = one row: truncated title (100px) + positioned bar
- Bar left offset = `(started_at - range_start) / range_duration * 100%`
- Bar width = `(completed_at - started_at) / range_duration * 100%` (active tasks: bar extends to "now")
- Hover: show task title, duration, cost tooltip (CSS `:hover` + `::after` pseudo-element)

## 5. Route Integration

### App.tsx

- Add `"dashboard"` to `View` type: `"tasks" | "settings" | "dashboard"`
- Render `<Dashboard wsMessages={wsMessages} />` when `view === "dashboard"`

### Sidebar.tsx

- Add Dashboard button between "All Tasks" and tree list
- CSS bar-chart icon (three vertical bars of different heights)
- Active state: `bg-emerald-500/10 text-emerald-400` (matches existing pattern)

## Empty States

- **No tasks in range:** "No task activity in the last {range}" with muted text
- **No gate data:** "No gate results recorded yet"
- **No cost data:** KPI cards show $0.00, cost bars section hidden

## Mobile Responsive

- KPI cards: 4-across → 2x2 grid below 640px
- Side-by-side panels (cost + gates): stack vertically
- Gantt timeline: horizontal scroll if tasks overflow
- Tab strip + time range: stack vertically on narrow screens
