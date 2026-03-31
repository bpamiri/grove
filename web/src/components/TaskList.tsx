import { useState, useEffect, useMemo } from "react";
import { api } from "../api/client";
import type { Task, Tree } from "../hooks/useTasks";
import type { StatusFilter } from "../App";
import TaskDetail from "./TaskDetail";
import TaskForm from "./TaskForm";
import Pipeline from "./Pipeline";
import SeedBadge from "./SeedBadge";
import ActivityIndicator from "./ActivityIndicator";
import BatchPlan from "./BatchPlan";
import { useSeed } from "../hooks/useSeed";
import type { WsMessage } from "../hooks/useWebSocket";

interface Props {
  tasks: Task[];
  trees: Tree[];
  paths: Record<string, { steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }> }>;
  getActivity: (taskId: string) => string | undefined;
  getActivityLog: (taskId: string) => Array<{ ts: number; msg: string }>;
  loadActivityLog: (taskId: string) => void;
  onRefresh: () => void;
  send: (data: any) => void;
  wsMessage?: WsMessage | null;
  filter: StatusFilter;
  onFilterChange: (f: StatusFilter) => void;
  selectedTreeName?: string | null;
  selectedTree?: string | null;
  allTasks?: Task[];
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-700 text-zinc-300",
  queued: "bg-cyan-900/50 text-cyan-400",
  active: "bg-blue-900/50 text-blue-400",
  completed: "bg-emerald-900/50 text-emerald-400",
  failed: "bg-red-900/50 text-red-400",
};

const STATUS_BORDER: Record<string, string> = {
  active: "border-blue-500/30",
  completed: "border-emerald-500/30",
  failed: "border-red-500/30",
};

export default function TaskList({ tasks, trees, paths, getActivity, getActivityLog, loadActivityLog, onRefresh, send, wsMessage, filter, onFilterChange, selectedTreeName, selectedTree, allTasks }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const seedState = useSeed(expandedId, send);
  const [showBatchPlan, setShowBatchPlan] = useState(false);

  // Count draft tasks for the selected tree (use allTasks to avoid filter bias)
  const draftCount = useMemo(() => {
    if (!selectedTree) return 0;
    return (allTasks ?? tasks).filter(t => t.tree_id === selectedTree && t.status === "draft").length;
  }, [selectedTree, allTasks, tasks]);

  useEffect(() => {
    if (wsMessage) seedState.handleWsMessage(wsMessage);
  }, [wsMessage, seedState.handleWsMessage]);
  const [showNewTask, setShowNewTask] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const selectedTreeObj = useMemo(() => {
    if (!selectedTree) return null;
    return trees.find(t => t.id === selectedTree) ?? null;
  }, [selectedTree, trees]);

  const importIssues = async () => {
    if (!selectedTree) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await api<{ imported: number; skipped: number; total: number }>(`/api/trees/${selectedTree}/import-issues`, { method: "POST" });
      setImportResult(`Imported ${res.imported}, skipped ${res.skipped} (${res.total} total)`);
      if (res.imported > 0) onRefresh();
      setTimeout(() => setImportResult(null), 4000);
    } catch (err) {
      console.error("Failed to import issues:", err);
      setImportResult("Import failed");
      setTimeout(() => setImportResult(null), 4000);
    } finally {
      setImporting(false);
    }
  };

  const dispatchTask = async (taskId: string) => {
    try {
      await api(`/api/tasks/${taskId}/dispatch`, { method: "POST" });
      onRefresh();
    } catch (err) {
      console.error("Failed to dispatch task:", err);
    }
  };

  const retryTask = async (taskId: string) => {
    try {
      await api(`/api/tasks/${taskId}/retry`, { method: "POST" });
      onRefresh();
    } catch (err) {
      console.error("Failed to retry task:", err);
    }
  };

  // Tasks are already filtered by status + tree in App.tsx
  const filtered = tasks;

  return (
    <div className="p-5">
      {/* Header */}
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-lg font-semibold">Tasks</h2>
        <div className="flex gap-2 text-xs items-center">
          {selectedTreeObj?.github && (
            <button
              onClick={importIssues}
              disabled={importing}
              className="bg-purple-500/20 text-purple-400 px-3 py-1 rounded-full hover:bg-purple-500/30 disabled:opacity-50 mr-1"
            >
              {importing ? "Importing..." : "Import Issues"}
            </button>
          )}
          {importResult && (
            <span className="text-[10px] text-zinc-400 mr-1">{importResult}</span>
          )}
          {selectedTree && draftCount >= 2 && (
            <button
              onClick={() => setShowBatchPlan(!showBatchPlan)}
              className="bg-cyan-500/20 text-cyan-400 px-3 py-1 rounded-full hover:bg-cyan-500/30 mr-1"
            >
              Plan Batch
            </button>
          )}
          <button
            onClick={() => setShowNewTask(!showNewTask)}
            className="bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full hover:bg-emerald-500/30 mr-2"
          >
            + New
          </button>
          {(["all", "active", "failed", "done"] as const).map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              className={`px-3 py-1 rounded-full capitalize ${
                filter === f
                  ? "bg-emerald-400/15 text-emerald-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* New task form */}
      {showNewTask && (
        <TaskForm
          trees={trees}
          paths={paths}
          allTasks={allTasks ?? tasks}
          defaultTreeId={selectedTree}
          onSave={() => { setShowNewTask(false); onRefresh(); }}
          onCancel={() => setShowNewTask(false)}
        />
      )}

      {/* Batch Plan */}
      {showBatchPlan && selectedTree && (
        <div className="mb-4">
          <BatchPlan
            treeId={selectedTree}
            onClose={() => setShowBatchPlan(false)}
            onRefresh={onRefresh}
          />
        </div>
      )}

      {/* Task cards */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-zinc-600 text-center py-12">
            No {filter !== "all" ? `${filter} ` : ""}tasks{selectedTreeName ? ` in ${selectedTreeName}` : ""}.
          </div>
        )}

        {filtered.map((task) => (
          <div key={task.id}>
            {/* Collapsed card */}
            <button
              onClick={() => {
                const newId = expandedId === task.id ? null : task.id;
                setExpandedId(newId);
                if (newId) loadActivityLog(newId);
              }}
              className={`w-full text-left rounded-lg border p-3.5 transition-colors ${
                STATUS_BORDER[task.status] ?? "border-zinc-800"
              } ${expandedId === task.id ? "bg-zinc-800/50" : "bg-zinc-900/30 hover:bg-zinc-800/30"}`}
            >
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate flex items-center gap-1.5">{task.title}{task.has_seed && <SeedBadge />}</div>
                  <div className="flex gap-2 text-xs text-zinc-500 mt-1">
                    {task.tree_id && <span>{task.tree_id}</span>}
                    <span>{task.id}</span>
                    <span>{task.path_name}</span>
                  </div>
                  {task.status === "active" && !task.paused && (
                    <div className="text-xs text-blue-400 mt-1.5">
                      {getActivity(task.id) ?? (
                        <ActivityIndicator since={task.started_at} label="Working" />
                      )}
                    </div>
                  )}
                  {task.status === "queued" && (
                    <div className="text-xs text-cyan-400/70 mt-1.5">
                      <ActivityIndicator since={null} label="Queued" />
                    </div>
                  )}
                  {task.cost_usd > 0 && (
                    <div className="text-xs text-zinc-500 mt-1">
                      ${task.cost_usd.toFixed(2)}
                      {task.started_at && ` \u00b7 ${timeSince(task.started_at)}`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {task.status === "draft" && (
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); dispatchTask(task.id); }}
                      className="text-xs px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 cursor-pointer"
                    >
                      Dispatch
                    </span>
                  )}
                  {(task.status === "failed" || (task.status === "active" && !!task.paused)) && (
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); retryTask(task.id); }}
                      className="text-xs px-2.5 py-1 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                    >
                      Retry
                    </span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${STATUS_COLORS[task.status] ?? "bg-zinc-800"}`}>
                    {task.status === "active" && task.current_step && task.current_step !== "$done" && task.current_step !== "$fail"
                      ? (task.paused ? `paused: ${task.current_step}` : task.current_step)
                      : task.status}
                  </span>
                </div>
              </div>

              {/* Pipeline mini (hidden when expanded to avoid duplicate) */}
              {expandedId !== task.id && ["active", "completed"].includes(task.status) && (
                <div className="mt-3">
                  <Pipeline task={task} steps={paths[task.path_name]?.steps ?? []} />
                </div>
              )}
            </button>

            {/* Expanded detail */}
            {expandedId === task.id && (
              <TaskDetail
                task={task}
                activityLog={getActivityLog(task.id)}
                steps={paths[task.path_name]?.steps ?? []}
                send={send}
                trees={trees}
                paths={paths}
                allTasks={allTasks ?? tasks}
                onRefresh={onRefresh}
                seed={seedState.seed}
                seedMessages={seedState.messages}
                seedActive={seedState.isActive}
                seedComplete={seedState.isSeeded}
                seedBottomRef={seedState.bottomRef}
                onSeedSend={seedState.sendMessage}
                onSeedStart={seedState.startSeed}
                onSeedStop={seedState.stopSeed}
                onSeedDiscard={seedState.discardSeed}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
