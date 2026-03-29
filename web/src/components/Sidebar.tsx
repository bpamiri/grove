import type { Tree, Status } from "../hooks/useTasks";

/** Group trees by org, derived from github field (owner/repo) or path (~/GitHub/{org}/...) */
function groupTreesByOrg(trees: Tree[]): [string, Tree[]][] {
  const groups = new Map<string, Tree[]>();
  for (const tree of trees) {
    let org = "other";
    if (tree.github) {
      org = tree.github.split("/")[0];
    } else {
      // Extract org from path like ~/GitHub/{org}/{repo}
      const match = tree.path.match(/GitHub\/([^/]+)\//i);
      if (match) org = match[1];
    }
    if (!groups.has(org)) groups.set(org, []);
    groups.get(org)!.push(tree);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

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
    <aside className="h-full flex flex-col bg-zinc-900/50 p-4 text-sm overflow-y-auto">
      {/* Logo */}
      <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest mb-6">
        Grove
      </div>

      {/* Trees grouped by org */}
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
        {groupTreesByOrg(trees).map(([org, orgTrees]) => (
          <div key={org} className="mt-2">
            <div className="text-zinc-600 text-[10px] uppercase tracking-wider px-2 py-0.5">{org}</div>
            {orgTrees.map((tree) => (
              <button
                key={tree.id}
                onClick={() => onSelectTree(tree.id)}
                className={`w-full text-left px-2 py-1 rounded text-sm truncate ${
                  selectedTree === tree.id ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-400 hover:text-zinc-200"
                }`}
                title={tree.path}
              >
                {tree.name}
              </button>
            ))}
          </div>
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
          {status?.remoteUrl && (
            <div className="mt-2 pt-2 border-t border-zinc-800">
              <a
                href={status.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-500/70 hover:text-emerald-400 break-all"
              >
                {status.remoteUrl.replace("https://", "")}
              </a>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
