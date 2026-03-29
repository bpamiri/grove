import { useState } from "react";
import type { Task } from "../hooks/useTasks";
import { useLocalStorage } from "../hooks/useLocalStorage";
import TaskDetail from "./TaskDetail";
import Pipeline from "./Pipeline";
import { ActivityIndicator } from "./ActivityIndicator";

interface Props {
  tasks: Task[];
  getActivity: (taskId: string) => string | undefined;
  onRefresh: () => void;
  send: (data: any) => void;
}

const STATUS_COLORS: Record<string, string> = {
  planned: "bg-zinc-700 text-zinc-300",
  ready: "bg-cyan-900/50 text-cyan-400",
  running: "bg-blue-900/50 text-blue-400",
  paused: "bg-yellow-900/50 text-yellow-400",
  done: "bg-emerald-900/50 text-emerald-400",
  evaluating: "bg-purple-900/50 text-purple-400",
  merged: "bg-emerald-900/50 text-emerald-400",
  completed: "bg-emerald-900/50 text-emerald-400",
  ci_failed: "bg-red-900/50 text-red-400",
  conflict: "bg-orange-900/50 text-orange-400",
  failed: "bg-red-900/50 text-red-400",
};

const STATUS_BORDER: Record<string, string> = {
  running: "border-blue-500/30",
  evaluating: "border-purple-500/30",
  done: "border-emerald-500/30",
  merged: "border-emerald-500/30",
  conflict: "border-orange-500/30",
  failed: "border-red-500/30",
};

export default function TaskList({ tasks, getActivity, onRefresh, send }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useLocalStorage<"all" | "active" | "done">("grove-ui-task-filter", "all");

  const filtered = tasks.filter((t) => {
    if (filter === "active") return ["planned", "ready", "running", "paused", "evaluating", "ci_failed", "conflict"].includes(t.status);
    if (filter === "done") return ["done", "merged", "completed"].includes(t.status);
    return true;
  });

  return (
    <div className="p-5">
      {/* Header */}
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-lg font-semibold">Tasks</h2>
        <div className="flex gap-2 text-xs">
          {(["all", "active", "done"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
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

      {/* Task cards */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-zinc-600 text-center py-12">
            No tasks{filter !== "all" ? ` (${filter})` : ""}. Chat with the orchestrator to create one.
          </div>
        )}

        {filtered.map((task) => (
          <div key={task.id}>
            {/* Collapsed card */}
            <button
              onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
              className={`w-full text-left rounded-lg border p-3.5 transition-colors ${
                STATUS_BORDER[task.status] ?? "border-zinc-800"
              } ${expandedId === task.id ? "bg-zinc-800/50" : "bg-zinc-900/30 hover:bg-zinc-800/30"}`}
            >
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{task.title}</div>
                  <div className="flex gap-2 text-xs text-zinc-500 mt-1">
                    {task.tree_id && <span>{task.tree_id}</span>}
                    <span>{task.id}</span>
                    <span>{task.path_name}</span>
                  </div>
                  {task.status === "running" && (
                    <div className="text-xs text-blue-400 mt-1.5">
                      <ActivityIndicator
                        label={getActivity(task.id) ?? "working..."}
                        since={task.started_at}
                      />
                    </div>
                  )}
                  {task.status === "ready" && (
                    <div className="text-xs text-cyan-400 mt-1.5">
                      <ActivityIndicator label="queued" />
                    </div>
                  )}
                  {task.cost_usd > 0 && (
                    <div className="text-xs text-zinc-500 mt-1">
                      ${task.cost_usd.toFixed(2)}
                      {task.started_at && ` \u00b7 ${timeSince(task.started_at)}`}
                    </div>
                  )}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${STATUS_COLORS[task.status] ?? "bg-zinc-800"}`}>
                  {task.status}
                </span>
              </div>

              {/* Pipeline mini */}
              {["running", "evaluating", "done", "merged", "ci_failed", "conflict"].includes(task.status) && (
                <div className="mt-3">
                  <Pipeline pathName={task.path_name} status={task.status} />
                </div>
              )}
            </button>

            {/* Expanded detail */}
            {expandedId === task.id && (
              <TaskDetail task={task} activity={getActivity(task.id)} send={send} />
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
