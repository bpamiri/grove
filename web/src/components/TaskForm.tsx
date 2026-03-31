import { useState, useEffect, useMemo } from "react";
import { api } from "../api/client";
import type { Task, Tree } from "../hooks/useTasks";

interface PathInfo {
  description: string;
  steps: Array<{ id: string; type: string; label: string }>;
}

interface Props {
  trees: Tree[];
  paths: Record<string, PathInfo>;
  allTasks: Task[];
  /** If provided, form is in edit mode with these values pre-populated */
  editTask?: Task | null;
  /** Pre-selected tree (from sidebar selection) */
  defaultTreeId?: string | null;
  onSave: () => void;
  onCancel: () => void;
}

const PRIORITY_OPTIONS = [
  { value: 0, label: "Low", color: "text-zinc-400" },
  { value: 1, label: "Medium", color: "text-amber-400" },
  { value: 2, label: "High", color: "text-red-400" },
];

export default function TaskForm({ trees, paths, allTasks, editTask, defaultTreeId, onSave, onCancel }: Props) {
  const isEdit = !!editTask;
  const isLimited = isEdit && editTask!.status !== "draft";

  // Form state
  const [title, setTitle] = useState(editTask?.title ?? "");
  const [description, setDescription] = useState(editTask?.description ?? "");
  const [treeId, setTreeId] = useState(editTask?.tree_id ?? defaultTreeId ?? "");
  const [pathName, setPathName] = useState(() => {
    if (editTask?.path_name) return editTask.path_name;
    if (defaultTreeId) {
      const tree = trees.find(t => t.id === defaultTreeId);
      if (tree?.default_path) return tree.default_path;
    }
    return "development";
  });
  const [priority, setPriority] = useState(editTask?.priority ?? 0);
  const [dependsOn, setDependsOn] = useState<string[]>(
    editTask?.depends_on ? editTask.depends_on.split(",").map(d => d.trim()).filter(Boolean) : []
  );
  const [parentTaskId, setParentTaskId] = useState(editTask?.parent_task_id ?? "");
  const [maxRetries, setMaxRetries] = useState(editTask?.max_retries ?? 2);
  const [labels, setLabels] = useState(editTask?.labels ?? "");
  const [showMore, setShowMore] = useState(isEdit);

  // GitHub issues
  const [issues, setIssues] = useState<Array<{ number: number; title: string; body: string; labels: Array<{ name: string }> }>>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(editTask?.github_issue ?? null);

  const [saving, setSaving] = useState(false);

  // Load issues when tree changes
  useEffect(() => {
    if (!treeId || isEdit) return;
    setLoadingIssues(true);
    api<any[]>(`/api/trees/${treeId}/issues`)
      .then(data => setIssues(Array.isArray(data) ? data : []))
      .catch(() => setIssues([]))
      .finally(() => setLoadingIssues(false));
  }, [treeId, isEdit]);

  const handleTreeChange = (id: string) => {
    setTreeId(id);
    setSelectedIssue(null);
    if (!isEdit) { setTitle(""); setDescription(""); }
    // Update path to tree's default_path (if set)
    const tree = trees.find(t => t.id === id);
    if (tree?.default_path) {
      setPathName(tree.default_path);
    } else if (!isEdit) {
      setPathName("development");
    }
  };

  const handleIssueSelect = (num: number) => {
    if (num === 0) { setSelectedIssue(null); if (!isEdit) { setTitle(""); setDescription(""); } return; }
    const issue = issues.find(i => i.number === num);
    if (issue) {
      setSelectedIssue(issue.number);
      setTitle(`${issue.title} Issue #${issue.number}`);
      setDescription(issue.body ?? "");
      setLabels(issue.labels?.map(l => l.name).join(",") ?? "");
    }
  };

  // Available tasks for dependency picker (exclude self, completed tasks shown dimmed)
  const depCandidates = useMemo(() => {
    return allTasks
      .filter(t => t.id !== editTask?.id)
      .filter(t => !treeId || t.tree_id === treeId || !t.tree_id);
  }, [allTasks, editTask?.id, treeId]);

  // Available tasks for parent picker
  const parentCandidates = useMemo(() => {
    return allTasks.filter(t => t.id !== editTask?.id && t.status !== "completed" && t.status !== "failed");
  }, [allTasks, editTask?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      if (isEdit) {
        const body: Record<string, unknown> = { title, description: description || null };
        if (!isLimited) {
          body.tree_id = treeId || null;
          body.path_name = pathName;
          body.priority = priority;
          body.depends_on = dependsOn.length > 0 ? dependsOn.join(",") : null;
          body.parent_task_id = parentTaskId || null;
          body.max_retries = maxRetries;
          body.github_issue = selectedIssue;
          body.labels = labels || null;
        }
        await api(`/api/tasks/${editTask!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const body: Record<string, unknown> = { title };
        if (treeId) body.tree_id = treeId;
        if (description) body.description = description;
        body.path_name = pathName;
        if (priority !== 0) body.priority = priority;
        if (dependsOn.length > 0) body.depends_on = dependsOn.join(",");
        if (parentTaskId) body.parent_task_id = parentTaskId;
        if (maxRetries !== 2) body.max_retries = maxRetries;
        if (selectedIssue) body.github_issue = selectedIssue;
        if (labels) body.labels = labels;
        await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      }
      onSave();
    } catch (err) {
      console.error(`Failed to ${isEdit ? "update" : "create"} task:`, err);
    } finally {
      setSaving(false);
    }
  };

  const toggleDep = (taskId: string) => {
    setDependsOn(prev => prev.includes(taskId) ? prev.filter(d => d !== taskId) : [...prev, taskId]);
  };

  return (
    <form onSubmit={handleSubmit} className="mb-4 p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg space-y-3">
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
        {isEdit ? `Edit ${editTask!.id}` : "New Task"}
        {isLimited && <span className="ml-2 text-amber-500/70">(limited — only title & description editable)</span>}
      </div>

      {/* Tree selector (create mode or draft edit) */}
      {!isLimited && (
        <select
          value={treeId}
          onChange={(e) => handleTreeChange(e.target.value)}
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
        >
          <option value="">Select a tree...</option>
          {trees.map((t) => (
            <option key={t.id} value={t.id}>{t.name}{t.github ? ` (${t.github})` : ""}</option>
          ))}
        </select>
      )}

      {/* GitHub issue selector (create mode with tree selected) */}
      {!isEdit && treeId && (
        <select
          value={selectedIssue ?? 0}
          onChange={(e) => handleIssueSelect(Number(e.target.value))}
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
        >
          <option value={0}>
            {loadingIssues ? "Loading issues..." : issues.length > 0 ? "Import from GitHub issue (optional)" : "No open issues — type custom title"}
          </option>
          {issues.map((issue) => (
            <option key={issue.number} value={issue.number}>
              #{issue.number} — {issue.title}
              {issue.labels?.length > 0 ? ` [${issue.labels.map(l => l.name).join(", ")}]` : ""}
            </option>
          ))}
        </select>
      )}

      {/* Path selector (always visible for drafts — key UX for W-040) */}
      {!isLimited && (
        <div>
          <div className="flex items-center gap-2">
            <select
              value={pathName}
              onChange={(e) => setPathName(e.target.value)}
              className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
            >
              {Object.entries(paths).map(([name, info]) => (
                <option key={name} value={name}>{name} — {info.description}</option>
              ))}
            </select>
            {treeId && (() => {
              const tree = trees.find(t => t.id === treeId);
              return tree?.default_path ? (
                <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                  tree default: <span className="text-zinc-400">{tree.default_path}</span>
                </span>
              ) : null;
            })()}
          </div>
          {paths[pathName] && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {paths[pathName].steps.map((step, i) => (
                <span key={step.id} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  {i > 0 && <span className="text-zinc-600 mr-1">→</span>}
                  {step.label || step.id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Labels preview (from selected issue) */}
      {labels && !showMore && (
        <div className="flex flex-wrap gap-1.5">
          {labels.split(",").map((label) => (
            <span key={label} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
              {label.trim()}
            </span>
          ))}
        </div>
      )}

      {/* Title */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        autoFocus
        className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
      />

      {/* Description */}
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 resize-y min-h-[60px]"
      />

      {/* More options toggle */}
      {!isLimited && (
        <button
          type="button"
          onClick={() => setShowMore(!showMore)}
          className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
        >
          <span className={`transition-transform ${showMore ? "rotate-90" : ""}`}>&#9654;</span>
          {showMore ? "Less options" : "More options"}
        </button>
      )}

      {/* Expanded options */}
      {showMore && !isLimited && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          {/* Priority */}
          <div>
            <label className="text-xs text-zinc-500 uppercase block mb-1">Priority</label>
            <div className="flex gap-2">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPriority(opt.value)}
                  className={`px-3 py-1.5 rounded text-xs transition-colors ${
                    priority === opt.value
                      ? `bg-zinc-700 ${opt.color} ring-1 ring-zinc-600`
                      : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Max retries */}
          <div>
            <label className="text-xs text-zinc-500 uppercase block mb-1">Max Retries</label>
            <input
              type="number"
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, parseInt(e.target.value) || 0))}
              min={0}
              max={10}
              className="w-24 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          {/* Labels */}
          <div>
            <label className="text-xs text-zinc-500 uppercase block mb-1">Labels</label>
            <input
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, enhancement, priority (comma-separated)"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
            />
            {labels && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {labels.split(",").filter(Boolean).map((label) => (
                  <span key={label} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                    {label.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Parent task */}
          <div>
            <label className="text-xs text-zinc-500 uppercase block mb-1">Parent Task (optional)</label>
            <select
              value={parentTaskId}
              onChange={(e) => setParentTaskId(e.target.value)}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="">None</option>
              {parentCandidates.map((t) => (
                <option key={t.id} value={t.id}>{t.id} — {t.title}</option>
              ))}
            </select>
          </div>

          {/* Dependency picker */}
          <DependencyPicker
            candidates={depCandidates}
            selected={dependsOn}
            onToggle={toggleDep}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-zinc-500 px-3 py-2 rounded-lg text-sm hover:text-zinc-300"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !title.trim()}
          className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Task"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Dependency Picker sub-component
// ---------------------------------------------------------------------------

const DEP_STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-700",
  queued: "bg-cyan-900/60",
  active: "bg-blue-900/60",
  completed: "bg-emerald-900/60",
  failed: "bg-red-900/60",
};

/** Build the full dependency chain for selected tasks (including transitive deps) */
function buildDepChain(selected: string[], allTasks: Task[]): string[][] {
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const chains: string[][] = [];

  for (const id of selected) {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current = id;
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current);
      const task = taskMap.get(current);
      // Walk the first dependency (for chain visualization)
      const deps = task?.depends_on?.split(",").map(d => d.trim()).filter(Boolean) ?? [];
      current = deps[0] ?? "";
    }
    if (chain.length > 1) chains.push(chain);
  }
  return chains;
}

function DependencyPicker({ candidates, selected, onToggle }: {
  candidates: Task[];
  selected: string[];
  onToggle: (taskId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(selected.length > 0);

  const filtered = useMemo(() => {
    if (!search) return candidates;
    const q = search.toLowerCase();
    return candidates.filter(t =>
      t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
    );
  }, [candidates, search]);

  // Compute transitive dependency chains for selected tasks
  const depChains = useMemo(
    () => buildDepChain(selected, candidates),
    [selected, candidates]
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-zinc-500 uppercase flex items-center gap-1 mb-1 hover:text-zinc-300"
      >
        Dependencies
        {selected.length > 0 && (
          <span className="bg-zinc-700 px-1.5 py-0.5 rounded-full text-[10px] text-zinc-300 ml-1">
            {selected.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="w-full bg-zinc-800/30 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none"
          />
          <div className="max-h-40 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="text-xs text-zinc-600 text-center py-3">No matching tasks</div>
            )}
            {filtered.map((t) => {
              const isSelected = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onToggle(t.id)}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-zinc-800/50 ${
                    isSelected ? "bg-emerald-500/10" : ""
                  }`}
                >
                  <span className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center ${
                    isSelected ? "border-emerald-500 bg-emerald-500/20" : "border-zinc-600"
                  }`}>
                    {isSelected && <span className="text-emerald-400 text-[8px]">&#10003;</span>}
                  </span>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DEP_STATUS_COLORS[t.status] ?? "bg-zinc-700"}`} />
                  <span className="text-zinc-500 flex-shrink-0">{t.id}</span>
                  <span className="text-zinc-300 truncate">{t.title}</span>
                  <span className="text-zinc-600 text-[10px] flex-shrink-0 ml-auto">{t.status}</span>
                </button>
              );
            })}
          </div>

          {/* Dependency chain preview */}
          {depChains.length > 0 && (
            <div className="border-t border-zinc-800 px-3 py-2 bg-zinc-900/30">
              <div className="text-[10px] text-zinc-600 uppercase mb-1">Dependency chain</div>
              {depChains.map((chain, i) => (
                <div key={i} className="flex items-center gap-1 flex-wrap text-[10px]">
                  {chain.map((id, j) => (
                    <span key={id} className="flex items-center gap-1">
                      {j > 0 && <span className="text-zinc-600">&rarr;</span>}
                      <span className={`px-1.5 py-0.5 rounded ${
                        selected.includes(id) ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"
                      }`}>
                        {id}
                      </span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
