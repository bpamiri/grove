import { useState, useEffect } from "react";
import { api } from "../api/client";
import type { Tree, Status } from "../hooks/useTasks";

interface Props {
  trees: Tree[];
  status: Status | null;
  onRefresh: () => void;
}

export default function Settings({ trees, status, onRefresh }: Props) {
  const [newTreePath, setNewTreePath] = useState("");
  const [newTreeGithub, setNewTreeGithub] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);

  const handleAddTree = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTreePath.trim()) return;
    setAdding(true);
    try {
      const body: Record<string, string> = { path: newTreePath };
      if (newTreeGithub.trim()) body.github = newTreeGithub.trim();
      await api("/api/trees", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNewTreePath("");
      setNewTreeGithub("");
      setShowAdvanced(false);
      onRefresh();
    } catch (err) {
      console.error("Failed to add tree:", err);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="p-5 max-w-2xl">
      <h2 className="text-lg font-semibold mb-6">Settings</h2>

      {/* Trees */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Trees</h3>
        <div className="space-y-2 mb-4">
          {trees.map((tree) => (
            <div key={tree.id} className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
              <div>
                <div className="font-medium">{tree.name}</div>
                <div className="text-xs text-zinc-500 font-mono mt-0.5">{tree.path}</div>
                {tree.github && <div className="text-xs text-zinc-500 mt-0.5">{tree.github}</div>}
              </div>
              <div className="text-xs text-zinc-600">{tree.branch_prefix}</div>
            </div>
          ))}
          {trees.length === 0 && (
            <div className="text-zinc-600 text-sm">No trees configured. Add one below or edit ~/.grove/grove.yaml</div>
          )}
        </div>

        <form onSubmit={handleAddTree} className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={newTreePath}
              onChange={(e) => setNewTreePath(e.target.value)}
              placeholder="/path/to/repo"
              className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
            />
            <button
              type="submit"
              disabled={adding || !newTreePath.trim()}
              className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
            >
              Add Tree
            </button>
          </div>
          {newTreePath.trim() && (
            <>
              {!showAdvanced && (
                <button type="button" onClick={() => setShowAdvanced(true)} className="text-xs text-zinc-500 hover:text-zinc-400">
                  + GitHub repo, branch prefix
                </button>
              )}
              {showAdvanced && (
                <input
                  type="text"
                  value={newTreeGithub}
                  onChange={(e) => setNewTreeGithub(e.target.value)}
                  placeholder="owner/repo (optional)"
                  className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
                />
              )}
            </>
          )}
        </form>
      </section>

      {/* Budget */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Budget</h3>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Today" value={`$${(status?.cost.today ?? 0).toFixed(2)}`} />
          <StatCard label="This Week" value={`$${(status?.cost.week ?? 0).toFixed(2)}`} />
        </div>
      </section>

      {/* System */}
      <section>
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">System</h3>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Workers" value={`${status?.workers ?? 0} active`} />
          <StatCard label="Queue" value={`${(status as any)?.queue ?? 0} pending`} />
          <StatCard label="Tasks" value={`${status?.tasks.total ?? 0} total`} />
          <StatCard label="WebSocket" value={`${status?.wsClients ?? 0} clients`} />
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="text-xs text-zinc-500 uppercase">{label}</div>
      <div className="text-sm font-medium mt-1">{value}</div>
    </div>
  );
}
