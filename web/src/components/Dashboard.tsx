import {
  useAnalytics,
  type CostAnalytics,
  type GateAnalytics,
  type TimelineTask,
} from "../hooks/useAnalytics";

/* ── KPI Cards ──────────────────────────────────────────── */

function KpiCards({ cost, timeline }: { cost: CostAnalytics | null; timeline: TimelineTask[] }) {
  const treeIds = new Set(timeline.map((t) => t.tree_id).filter(Boolean));
  const cards = [
    { label: "Today", value: `$${(cost?.today ?? 0).toFixed(2)}` },
    { label: "This Week", value: `$${(cost?.week ?? 0).toFixed(2)}` },
    { label: "Trees", value: `${treeIds.size}` },
    { label: "Tasks Tracked", value: `${timeline.length}` },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-zinc-800 border border-zinc-700/50 rounded-lg px-4 py-3">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">{c.label}</div>
          <div className="text-lg font-semibold mt-1 text-zinc-100">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Time Range Buttons ─────────────────────────────────── */

const TIME_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "4h", hours: 4 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

function TimeRangeButtons({
  current,
  onChange,
}: {
  current: number;
  onChange: (h: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {TIME_OPTIONS.map((opt) => (
        <button
          key={opt.hours}
          onClick={() => onChange(opt.hours)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            current === opt.hours
              ? "bg-emerald-500/20 text-emerald-400"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── Timeline Section ───────────────────────────────────── */

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
    case "active":
      return "bg-blue-500";
    default:
      return "bg-zinc-600";
  }
}

function TimelineSection({
  timeline,
  timeRange,
  setTimeRange,
}: {
  timeline: TimelineTask[];
  timeRange: number;
  setTimeRange: (h: number) => void;
}) {
  const now = Date.now();
  const windowMs = timeRange * 3600 * 1000;
  const windowStart = now - windowMs;

  // Filter tasks that overlap with the time window
  const visible = timeline.filter((t) => {
    const created = new Date(t.created_at).getTime();
    const ended = t.completed_at ? new Date(t.completed_at).getTime() : now;
    return ended >= windowStart && created <= now;
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Timeline</h3>
        <TimeRangeButtons current={timeRange} onChange={setTimeRange} />
      </div>
      {visible.length === 0 ? (
        <div className="text-zinc-600 text-sm py-4">No tasks in this time window.</div>
      ) : (
        <div className="space-y-1.5">
          {visible.map((task) => {
            const created = new Date(task.created_at).getTime();
            const ended = task.completed_at ? new Date(task.completed_at).getTime() : now;
            const leftPct = Math.max(0, ((created - windowStart) / windowMs) * 100);
            const widthPct = Math.max(1, ((Math.min(ended, now) - Math.max(created, windowStart)) / windowMs) * 100);

            return (
              <div key={task.id} className="group relative h-7 rounded bg-zinc-800/50" title="">
                <div
                  className={`absolute top-0 h-full rounded ${statusColor(task.status)} opacity-80 group-hover:opacity-100 transition-opacity`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "4px" }}
                />
                {/* Hover tooltip */}
                <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
                  <span className="text-[11px] text-zinc-300 truncate opacity-0 group-hover:opacity-100 transition-opacity relative z-10">
                    {task.title} &mdash; {task.status} &mdash; ${task.cost_usd.toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── Cost by Tree Section ───────────────────────────────── */

function CostSection({ cost }: { cost: CostAnalytics | null }) {
  const byTree = cost?.by_tree ?? [];
  const maxCost = Math.max(...byTree.map((t) => t.total_cost), 0.01);

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Cost by Tree</h3>
      {byTree.length === 0 ? (
        <div className="text-zinc-600 text-sm py-4">No cost data yet.</div>
      ) : (
        <div className="space-y-2">
          {byTree.map((tree) => {
            const pct = (tree.total_cost / maxCost) * 100;
            return (
              <div key={tree.tree_id}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-zinc-400 truncate mr-2">{tree.tree_id}</span>
                  <span className="text-zinc-300 flex-shrink-0">
                    ${tree.total_cost.toFixed(2)} ({tree.task_count} tasks)
                  </span>
                </div>
                <div className="h-2 rounded bg-zinc-800">
                  <div
                    className="h-full rounded bg-emerald-500/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── Gate Analytics Section ──────────────────────────────── */

function GateSection({ gates }: { gates: GateAnalytics | null }) {
  const byGate = gates?.by_gate ?? [];
  const retry = gates?.retry_stats;

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Gate Analytics</h3>
      {byGate.length === 0 ? (
        <div className="text-zinc-600 text-sm py-4">No gate data yet.</div>
      ) : (
        <div className="space-y-2">
          {byGate.map((g) => {
            const passPct = g.total > 0 ? (g.passed / g.total) * 100 : 0;
            const failPct = g.total > 0 ? (g.failed / g.total) * 100 : 0;
            return (
              <div key={g.gate}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-zinc-400">{g.gate}</span>
                  <span className="text-zinc-500">
                    {g.passed}p / {g.failed}f ({g.total} total)
                  </span>
                </div>
                <div className="h-2 rounded bg-zinc-800 flex overflow-hidden">
                  <div className="h-full bg-emerald-500/70" style={{ width: `${passPct}%` }} />
                  <div className="h-full bg-red-500/70" style={{ width: `${failPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {retry && (
        <div className="mt-4 pt-3 border-t border-zinc-800 text-xs text-zinc-500">
          <span className="mr-4">
            Retry rate: {retry.total_tasks > 0 ? ((retry.retried_tasks / retry.total_tasks) * 100).toFixed(0) : 0}%
          </span>
          <span>Avg retries: {retry.avg_retries.toFixed(1)}</span>
        </div>
      )}
    </section>
  );
}

/* ── Dashboard (main) ────────────────────────────────────── */

export default function Dashboard() {
  const { cost, gates, timeline, timeRange, setTimeRange, loading, refresh } = useAnalytics();

  return (
    <div className="p-5 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div className="space-y-8">
        <KpiCards cost={cost} timeline={timeline} />
        <TimelineSection timeline={timeline} timeRange={timeRange} setTimeRange={setTimeRange} />
        <CostSection cost={cost} />
        <GateSection gates={gates} />
      </div>
    </div>
  );
}
