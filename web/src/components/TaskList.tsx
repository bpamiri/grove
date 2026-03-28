import { useState, useEffect } from "react";
import { api } from "../api/client";
import type { Task, Tree } from "../hooks/useTasks";
import TaskDetail from "./TaskDetail";
import Pipeline from "./Pipeline";
import SeedBadge from "./SeedBadge";
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

export default function TaskList({ tasks, trees, paths, getActivity, getActivityLog, loadActivityLog, onRefresh, send, wsMessage }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const seedState = useSeed(expandedId, send);

  useEffect(() => {
    if (wsMessage) seedState.handleWsMessage(wsMessage);
  }, [wsMessage, seedState.handleWsMessage]);
  const [filter, setFilter] = useState<"all" | "active" | "done">("active");
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTreeId, setNewTreeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [issues, setIssues] = useState<Array<{ number: number; title: string; body: string; labels: Array<{ name: string }> }>>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  const loadIssues = async (treeId: string) => {
    if (!treeId) { setIssues([]); return; }
    setLoadingIssues(true);
    try {
      const data = await api<any[]>(`/api/trees/${treeId}/issues`);
      setIssues(Array.isArray(data) ? data : []);
    } catch { setIssues([]); }
    finally { setLoadingIssues(false); }
  };

  const handleTreeChange = (treeId: string) => {
    setNewTreeId(treeId);
    setSelectedIssue(null);
    setNewTitle("");
    setNewDescription("");
    loadIssues(treeId);
  };

  const handleIssueSelect = (issueNum: number) => {
    if (issueNum === 0) {
      setSelectedIssue(null);
      setNewTitle("");
      setNewDescription("");
      return;
    }
    const issue = issues.find(i => i.number === issueNum);
    if (issue) {
      setSelectedIssue(issue.number);
      setNewTitle(`${issue.title} Issue #${issue.number}`);
      setNewDescription(issue.body ?? "");
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const body: Record<string, string> = { title: newTitle };
      if (newTreeId) body.tree_id = newTreeId;
      if (newDescription) body.description = newDescription;
      await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      setNewTitle("");
      setNewDescription("");
      setNewTreeId("");
      setSelectedIssue(null);
      setIssues([]);
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

  const retryTask = async (taskId: string) => {
    try {
      await api(`/api/tasks/${taskId}/retry`, { method: "POST" });
      onRefresh();
    } catch (err) {
      console.error("Failed to retry task:", err);
    }
  };

  const filtered = tasks.filter((t) => {
    if (filter === "active") return ["draft", "queued", "active"].includes(t.status);
    if (filter === "done") return ["completed"].includes(t.status);
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
          <select
            value={newTreeId}
            onChange={(e) => handleTreeChange(e.target.value)}
            className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
          >
            <option value="">Select a tree...</option>
            {trees.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.github ? ` (${t.github})` : ""}</option>
            ))}
          </select>

          {newTreeId && (
            <select
              value={selectedIssue ?? 0}
              onChange={(e) => handleIssueSelect(Number(e.target.value))}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
            >
              <option value={0}>
                {loadingIssues ? "Loading issues..." : issues.length > 0 ? "Select an issue (or type custom)" : "No open issues — type custom title"}
              </option>
              {issues.map((issue) => (
                <option key={issue.number} value={issue.number}>
                  #{issue.number} — {issue.title}
                  {issue.labels?.length > 0 ? ` [${issue.labels.map(l => l.name).join(", ")}]` : ""}
                </option>
              ))}
            </select>
          )}

          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
          />

          {newDescription && (
            <div className="text-xs text-zinc-500 bg-zinc-800/30 rounded-lg px-3 py-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
              {newDescription.slice(0, 500)}{newDescription.length > 500 ? "..." : ""}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => { setShowNewTask(false); setIssues([]); setSelectedIssue(null); }}
              className="text-zinc-500 px-3 py-2 rounded-lg text-sm hover:text-zinc-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !newTitle.trim()}
              className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create Task"}
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
                  <div className="font-medium truncate flex items-center gap-1.5">{task.title}{task.has_seed && <SeedBadge />}</div>
                  <div className="flex gap-2 text-xs text-zinc-500 mt-1">
                    {task.tree_id && <span>{task.tree_id}</span>}
                    <span>{task.id}</span>
                    <span>{task.path_name}</span>
                  </div>
                  {task.status === "active" && !task.paused && (
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
