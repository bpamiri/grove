import type { Tree, Status } from "../hooks/useTasks";

interface Props {
  trees: Tree[];
  status: Status | null;
  selectedTree: string | null;
  onSelectTree: (id: string | null) => void;
  connected: boolean;
  view: "tasks" | "settings";
  onViewChange: (view: "tasks" | "settings") => void;
}

export default function Sidebar({ trees, status, selectedTree, onSelectTree, connected, view, onViewChange }: Props) {
  return (
    <aside className="w-60 flex flex-col bg-zinc-900/50 p-4 text-sm">
      {/* Logo */}
      <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest mb-6">
        Grove
      </div>

      {/* Trees */}
      <div className="mb-6">
        <div className="text-zinc-500 text-xs uppercase mb-2">Trees</div>
        <button
          onClick={() => onSelectTree(null)}
          className={`w-full text-left px-2 py-1.5 rounded text-sm ${
            selectedTree === null ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          All trees
        </button>
        {trees.map((tree) => (
          <button
            key={tree.id}
            onClick={() => onSelectTree(tree.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex justify-between ${
              selectedTree === tree.id ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <span>{tree.name}</span>
            {tree.github && <span className="text-zinc-600 text-xs">{tree.github.split("/").pop()}</span>}
          </button>
        ))}
        {trees.length === 0 && (
          <div className="text-zinc-600 text-xs px-2 py-1">No trees configured</div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="mb-6">
        <div className="text-zinc-500 text-xs uppercase mb-2">Views</div>
        <button
          onClick={() => onViewChange("tasks")}
          className={`w-full text-left px-2 py-1.5 rounded text-sm ${
            view === "tasks" ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Tasks
        </button>
        <button
          onClick={() => onViewChange("settings")}
          className={`w-full text-left px-2 py-1.5 rounded text-sm ${
            view === "settings" ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Settings
        </button>
      </div>

      {/* System Status */}
      <div className="mt-auto">
        <div className="text-zinc-500 text-xs uppercase mb-2">System</div>
        <div className="space-y-1 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>Broker</span>
            <span className={status?.broker === "running" ? "text-emerald-400" : "text-red-400"}>
              {status?.broker ?? "unknown"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Orchestrator</span>
            <span className={status?.orchestrator === "running" ? "text-emerald-400" : "text-yellow-400"}>
              {status?.orchestrator ?? "unknown"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Workers</span>
            <span>{status?.workers ?? 0} active</span>
          </div>
          <div className="flex justify-between">
            <span>WebSocket</span>
            <span className={connected ? "text-emerald-400" : "text-red-400"}>
              {connected ? "connected" : "disconnected"}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Today</span>
            <span>${(status?.cost.today ?? 0).toFixed(2)}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
