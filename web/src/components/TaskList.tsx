import { useState } from "react";
import { api } from "../api/client";
import type { Task, Tree } from "../hooks/useTasks";
import TaskDetail from "./TaskDetail";
import Pipeline from "./Pipeline";

interface Props {
  tasks: Task[];
  trees: Tree[];
  getActivity: (taskId: string) => string | undefined;
  getActivityLog: (taskId: string) => Array<{ ts: number; msg: string }>;
  loadActivityLog: (taskId: string) => void;
  onRefresh: () => void;
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
  failed: "bg-red-900/50 text-red-400",
};

const STATUS_BORDER: Record<string, string> = {
  running: "border-blue-500/30",
  evaluating: "border-purple-500/30",
  done: "border-emerald-500/30",
  merged: "border-emerald-500/30",
  failed: "border-red-500/30",
};

export default function TaskList({ tasks, trees, getActivity, getActivityLog, loadActivityLog, onRefresh }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "done">("all");
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newTreeId, setNewTreeId] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const body: Record<string, string> = { title: newTitle };
      if (newTreeId) body.tree_id = newTreeId;
      await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      setNewTitle("");
      setNewTreeId("");
      setShowNewTask(false);
      onRefresh();
    } catch (err) {
      console.error("Failed to create task:", err);
    } finally {
      setCreating(false);
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

  const filtered = tasks.filter((t) => {
    if (filter === "active") return ["planned", "ready", "running", "paused", "evaluating"].includes(t.status);
    if (filter === "done") return ["done", "merged", "completed"].includes(t.status);
    return true;
  });

  return (
    <div className="p-5">
      {/* Header */}
      <div className="flex justify-between items-center mb-5">
        <h2 className="text-lg font-semibold">Tasks</h2>
        <div className="flex gap-2 text-xs items-center">
          <button
            onClick={() => setShowNewTask(!showNewTask)}
            className="bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full hover:bg-emerald-500/30 mr-2"
          >
            + New
          </button>
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

      {/* New task form */}
      {showNewTask && (
        <form onSubmit={handleCreateTask} className="mb-4 p-3 bg-zinc-900/50 border border-zinc-800 rounded-lg space-y-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
          />
          <div className="flex gap-2">
            <select
              value={newTreeId}
              onChange={(e) => setNewTreeId(e.target.value)}
              className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="">No tree (general)</option>
              {trees.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={creating || !newTitle.trim()}
              className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowNewTask(false)}
              className="text-zinc-500 px-3 py-2 rounded-lg text-sm hover:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

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
                  <div className="font-medium truncate">{task.title}</div>
                  <div className="flex gap-2 text-xs text-zinc-500 mt-1">
                    {task.tree_id && <span>{task.tree_id}</span>}
                    <span>{task.id}</span>
                    <span>{task.path_name}</span>
                  </div>
                  {task.status === "running" && (
                    <div className="text-xs text-blue-400 mt-1.5">
                      {getActivity(task.id) ?? "working..."}
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
                  {task.status === "planned" && (
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); dispatchTask(task.id); }}
                      className="text-xs px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 cursor-pointer"
                    >
                      Dispatch
                    </span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${STATUS_COLORS[task.status] ?? "bg-zinc-800"}`}>
                    {task.status}
                  </span>
                </div>
              </div>

              {/* Pipeline mini (hidden when expanded to avoid duplicate) */}
              {expandedId !== task.id && ["running", "evaluating", "done", "merged"].includes(task.status) && (
                <div className="mt-3">
                  <Pipeline pathName={task.path_name} status={task.status} />
                </div>
              )}
            </button>

            {/* Expanded detail */}
            {expandedId === task.id && <TaskDetail task={task} activityLog={getActivityLog(task.id)} />}
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
