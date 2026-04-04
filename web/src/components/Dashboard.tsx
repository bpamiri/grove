import { useState, useEffect, useCallback } from "react";
import { useAnalytics, type TimeRange, type DashboardTab, type CostData, type GateData, type TimelineData, type TimelineTask, type GateAnalytics, type UtilizationBucket, type InsightsData } from "../hooks/useAnalytics";
import type { WsMessage } from "../hooks/useWebSocket";
import type { Status, Tree } from "../hooks/useTasks";
import ActivityTimeline from "./ActivityTimeline";
import WorkerUtilization from "./WorkerUtilization";
import EventLogViewer from "./EventLogViewer";
import { api } from "../api/client";

interface WavePlan {
  treeId: string;
  waves: Array<{ wave: number; taskIds: string[] }>;
  taskWaves: Record<string, number>;
}

interface Props {
  wsMessages: WsMessage[];
  status: Status | null;
  trees?: Tree[];
  selectedTree?: string | null;
}

export default function Dashboard({ wsMessages, status, trees, selectedTree }: Props) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [range, setRange] = useState<TimeRange>("24h");
  const { costData, gateData, timelineData, utilizationData, insightsData, loading, refresh } = useAnalytics(range, activeTab, wsMessages);

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
          {activeTab === "activity" && (
            <ActivityTab timelineData={timelineData} utilizationData={utilizationData} range={range} />
          )}
          {activeTab === "events" && (
            <EventsTab />
          )}
          {activeTab === "insights" && (
            <InsightsTab data={insightsData} />
          )}
          {activeTab === "batch" && (
            <BatchTab trees={trees ?? []} selectedTree={selectedTree ?? null} />
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
    { id: "activity", label: "Activity" },
    { id: "events", label: "Events" },
    { id: "insights", label: "Insights" },
    { id: "batch", label: "Batch" },
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

// ---- Activity Tab ----

const RANGE_MS: Record<TimeRange, number> = { "1h": 3600000, "4h": 14400000, "24h": 86400000, "7d": 604800000 };

function ActivityTab({ timelineData, utilizationData, range }: {
  timelineData: TimelineData | null;
  utilizationData: UtilizationBucket[] | null;
  range: TimeRange;
}) {
  const tasks = timelineData?.tasks ?? [];
  const rangeMs = RANGE_MS[range];

  return (
    <>
      <Panel title="Activity Timeline">
        <ActivityTimeline data={tasks} rangeMs={rangeMs} />
      </Panel>
      <div className="mt-3">
        <Panel title="Worker Utilization">
          <WorkerUtilization data={utilizationData ?? []} maxWorkers={5} />
        </Panel>
      </div>
    </>
  );
}

// ---- Events Tab ----

function EventsTab() {
  return (
    <Panel title="Event Log">
      <EventLogViewer />
    </Panel>
  );
}

// ---- Insights Tab ----

function InsightsTab({ data }: { data: InsightsData | null }) {
  if (!data) {
    return <div className="text-zinc-600 text-xs py-4 text-center">Loading insights...</div>;
  }

  const hasData = data.failing_gates.length > 0 || data.common_failures.length > 0 || data.success_trend.length > 0 || data.retries_by_path.length > 0 || data.tree_failure_rates.length > 0;

  if (!hasData) {
    return (
      <Panel title="Task Outcome Insights">
        <div className="text-zinc-600 text-xs py-4 text-center">No completed or failed tasks in this time range</div>
      </Panel>
    );
  }

  return (
    <>
      {/* KPI summary */}
      <InsightKpis data={data} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        {/* Most-failing gates */}
        <Panel title="Most-Failing Gates">
          {data.failing_gates.length === 0 ? (
            <div className="text-zinc-600 text-xs py-2 text-center">No gate failures</div>
          ) : (
            <div className="space-y-2">
              {data.failing_gates.map((g) => {
                const maxFail = data.failing_gates[0]?.fail_count ?? 1;
                return (
                  <div key={g.gate}>
                    <div className="flex justify-between text-[10px] mb-0.5">
                      <span className="text-zinc-400">{g.gate}</span>
                      <span className="text-red-400">{g.fail_count} failures</span>
                    </div>
                    <div className="bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div className="bg-red-500 h-full rounded-full transition-all" style={{ width: `${(g.fail_count / maxFail) * 100}%` }} />
                    </div>
                    {g.top_message && (
                      <div className="text-[9px] text-zinc-600 mt-0.5 truncate" title={g.top_message}>
                        → {g.top_message} <span className="text-zinc-700">(×{g.top_message_count})</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Common failure reasons */}
        <Panel title="Common Failure Reasons">
          {data.common_failures.length === 0 ? (
            <div className="text-zinc-600 text-xs py-2 text-center">No failures recorded</div>
          ) : (
            <div className="space-y-1.5">
              {data.common_failures.slice(0, 8).map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-[10px]">
                  <span className="text-red-400 flex-shrink-0 font-mono">×{f.count}</span>
                  <span className="text-zinc-500 flex-shrink-0">{f.gate}</span>
                  <span className="text-zinc-400 truncate" title={f.message}>{f.message}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        {/* Retries by path */}
        <Panel title="Retries by Path">
          {data.retries_by_path.length === 0 ? (
            <div className="text-zinc-600 text-xs py-2 text-center">No data</div>
          ) : (
            <div className="space-y-2">
              {data.retries_by_path.map((p) => {
                const retryPct = p.task_count > 0 ? Math.round((p.retried_count / p.task_count) * 100) : 0;
                return (
                  <div key={p.path_name}>
                    <div className="flex justify-between text-[10px] mb-0.5">
                      <span className="text-zinc-400">{p.path_name}</span>
                      <span className="text-zinc-500">{retryPct}% retried · avg {p.avg_retries.toFixed(1)} per retry</span>
                    </div>
                    <div className="bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div className="bg-amber-500 h-full rounded-full transition-all" style={{ width: `${retryPct}%` }} />
                    </div>
                    <div className="text-[9px] text-zinc-600 mt-0.5">
                      {p.task_count} tasks · {p.retried_count} retried · max {p.max_retries}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Tree success rates */}
        <Panel title="Tree Success Rates">
          {data.tree_failure_rates.length === 0 ? (
            <div className="text-zinc-600 text-xs py-2 text-center">No data</div>
          ) : (
            <div className="space-y-2">
              {data.tree_failure_rates.map((t) => {
                const color = t.success_rate >= 80 ? "bg-emerald-500" : t.success_rate >= 50 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={t.tree_id}>
                    <div className="flex justify-between text-[10px] mb-0.5">
                      <span className="text-zinc-400">{t.tree_name ?? t.tree_id}</span>
                      <span className={t.success_rate >= 80 ? "text-emerald-400" : t.success_rate >= 50 ? "text-amber-400" : "text-red-400"}>
                        {t.success_rate}%
                      </span>
                    </div>
                    <div className="bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div className={`${color} h-full rounded-full transition-all`} style={{ width: `${t.success_rate}%` }} />
                    </div>
                    <div className="text-[9px] text-zinc-600 mt-0.5">
                      {t.completed} completed · {t.failed} failed
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* Success rate trend */}
      {data.success_trend.length > 1 && (
        <div className="mt-3">
          <Panel title="Success Rate Trend">
            <SuccessRateChart data={data.success_trend} />
          </Panel>
        </div>
      )}
    </>
  );
}

function InsightKpis({ data }: { data: InsightsData }) {
  const totalTasks = data.success_trend.reduce((s, d) => s + d.total, 0);
  const totalFailed = data.success_trend.reduce((s, d) => s + d.failed, 0);
  const overallRate = totalTasks > 0 ? Math.round(((totalTasks - totalFailed) / totalTasks) * 100) : 0;
  const topGate = data.failing_gates[0];
  const totalRetried = data.retries_by_path.reduce((s, p) => s + p.retried_count, 0);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-1">
      <KpiCard label="Success Rate" value={totalTasks > 0 ? `${overallRate}%` : "—"} sub={`${totalTasks - totalFailed}/${totalTasks} tasks`} />
      <KpiCard label="Total Failures" value={String(totalFailed)} sub={totalFailed > 0 ? `across ${data.tree_failure_rates.filter(t => t.failed > 0).length} trees` : "none"} />
      <KpiCard label="Top Failing Gate" value={topGate?.gate ?? "—"} sub={topGate ? `${topGate.fail_count} failures` : "no failures"} />
      <KpiCard label="Tasks Retried" value={String(totalRetried)} sub={`${data.retries_by_path.length} paths`} />
    </div>
  );
}

function SuccessRateChart({ data }: { data: InsightsData["success_trend"] }) {
  const maxTotal = Math.max(...data.map(d => d.total));

  return (
    <div className="space-y-1">
      {data.map((d) => (
        <div key={d.date} className="flex items-center gap-2">
          <div className="text-[9px] text-zinc-600 w-16 flex-shrink-0">{d.date.slice(5)}</div>
          <div className="flex-1 flex h-3 rounded-full overflow-hidden bg-zinc-800">
            {d.completed > 0 && (
              <div className="bg-emerald-500 transition-all" style={{ width: `${(d.completed / maxTotal) * 100}%` }} title={`${d.completed} completed`} />
            )}
            {d.failed > 0 && (
              <div className="bg-red-500 transition-all" style={{ width: `${(d.failed / maxTotal) * 100}%` }} title={`${d.failed} failed`} />
            )}
          </div>
          <div className="text-[9px] text-zinc-500 w-10 text-right">{d.success_rate}%</div>
        </div>
      ))}
    </div>
  );
}

// ---- Batch Tab ----

const WAVE_COLORS = ["#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#10b981", "#f97316", "#6366f1", "#14b8a6"];

function BatchTab({ trees, selectedTree }: { trees: Tree[]; selectedTree: string | null }) {
  const [treeId, setTreeId] = useState<string | null>(selectedTree);
  const [plan, setPlan] = useState<WavePlan | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPlan = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await api<WavePlan>(`/api/batch/plan?treeId=${id}`);
      setPlan(data);
    } catch {
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (treeId) fetchPlan(treeId);
    else setPlan(null);
  }, [treeId, fetchPlan]);

  // Auto-select if parent passes a tree
  useEffect(() => {
    if (selectedTree && selectedTree !== treeId) setTreeId(selectedTree);
  }, [selectedTree]);

  const totalTasks = plan?.waves.reduce((s, w) => s + w.taskIds.length, 0) ?? 0;
  const maxParallel = plan?.waves.reduce((max, w) => Math.max(max, w.taskIds.length), 0) ?? 0;

  return (
    <>
      {/* Tree selector */}
      <div className="mb-4">
        <select
          value={treeId ?? ""}
          onChange={e => setTreeId(e.target.value || null)}
          className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded px-2 py-1.5"
        >
          <option value="">Select a tree...</option>
          {trees.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="text-zinc-500 text-sm py-8 text-center">Analyzing batch plan...</div>
      )}

      {!loading && !plan && treeId && (
        <div className="text-zinc-600 text-sm py-8 text-center">No draft tasks in this tree</div>
      )}

      {plan && plan.waves.length > 0 && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <KpiCard label="Total Waves" value={String(plan.waves.length)} sub={`${totalTasks} tasks total`} />
            <KpiCard label="Max Parallelism" value={String(maxParallel)} sub="tasks in largest wave" />
            <KpiCard label="Avg per Wave" value={totalTasks > 0 ? (totalTasks / plan.waves.length).toFixed(1) : "0"} sub="tasks per wave" />
            <KpiCard label="Sequential Steps" value={String(plan.waves.length)} sub={plan.waves.length === 1 ? "all parallel" : `${plan.waves.length} sequential batches`} />
          </div>

          {/* Wave breakdown */}
          <Panel title="Execution Waves">
            <div className="space-y-3">
              {plan.waves.map(w => {
                const color = WAVE_COLORS[(w.wave - 1) % WAVE_COLORS.length];
                const pct = totalTasks > 0 ? (w.taskIds.length / totalTasks) * 100 : 0;
                return (
                  <div key={w.wave}>
                    <div className="flex justify-between items-center text-[10px] mb-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-sm"
                          style={{ background: color }}
                        />
                        <span className="text-zinc-300 font-medium">Wave {w.wave}</span>
                        <span className="text-zinc-600">
                          {w.taskIds.length} {w.taskIds.length === 1 ? "task" : "tasks"} — {w.taskIds.length > 1 ? "parallel" : "single"}
                        </span>
                      </div>
                      <span className="text-zinc-500">{Math.round(pct)}%</span>
                    </div>
                    <div className="bg-zinc-800 h-3 rounded-full overflow-hidden mb-1">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {w.taskIds.map(id => (
                        <span key={id} className="text-[10px] font-mono text-zinc-400 bg-zinc-800/50 px-1.5 py-0.5 rounded">
                          {id}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Parallelism chart */}
          <div className="mt-3">
            <Panel title="Tasks per Wave">
              <div className="flex items-end gap-2 h-24">
                {plan.waves.map(w => {
                  const color = WAVE_COLORS[(w.wave - 1) % WAVE_COLORS.length];
                  const heightPct = maxParallel > 0 ? (w.taskIds.length / maxParallel) * 100 : 0;
                  return (
                    <div key={w.wave} className="flex-1 flex flex-col items-center">
                      <div className="text-[9px] text-zinc-500 mb-1">{w.taskIds.length}</div>
                      <div
                        className="w-full rounded-t transition-all"
                        style={{ height: `${heightPct}%`, background: color, opacity: 0.85 }}
                        title={`Wave ${w.wave}: ${w.taskIds.length} tasks`}
                      />
                      <div className="text-[9px] text-zinc-600 mt-1">W{w.wave}</div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </>
      )}

      {plan && plan.waves.length === 0 && (
        <div className="text-zinc-600 text-sm py-8 text-center">No draft tasks to analyze</div>
      )}
    </>
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
