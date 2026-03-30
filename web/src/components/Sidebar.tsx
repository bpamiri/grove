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
  taskCount: number;
  selectedTree: string | null;
  onSelectTree: (id: string | null) => void;
  connected: boolean;
  onSettingsClick: () => void;
  onDashboardClick: () => void;
}

export default function Sidebar({ trees, status, taskCount, selectedTree, onSelectTree, connected, onSettingsClick, onDashboardClick }: Props) {
  return (
    <aside className="h-full flex flex-col bg-zinc-900/50 p-4 text-sm overflow-y-auto">
      {/* Header: Logo + Gear */}
      <div className="flex items-center justify-between mb-6">
        <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest">Grove</div>
        <button onClick={onSettingsClick} className="text-zinc-500 hover:text-zinc-300 text-lg" title="Settings">&#9881;</button>
      </div>

      {/* All Tasks */}
      <button
        onClick={() => onSelectTree(null)}
        className={`w-full text-left px-2 py-1.5 rounded text-sm flex justify-between mb-4 ${
          selectedTree === null ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        <span>All Tasks</span>
        <span className="text-[11px] opacity-70">{taskCount}</span>
      </button>

      <button
        onClick={onDashboardClick}
        className="w-full text-left px-2 py-1.5 rounded text-sm text-zinc-400 hover:text-zinc-200 mb-4 flex items-center gap-2"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" className="flex-shrink-0">
          <rect x="1" y="8" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.6" />
          <rect x="5.5" y="4" width="3" height="9" rx="0.5" fill="currentColor" opacity="0.8" />
          <rect x="10" y="1" width="3" height="12" rx="0.5" fill="currentColor" />
        </svg>
        <span>Dashboard</span>
      </button>

      {/* Trees grouped by org */}
      <div className="flex-1 overflow-y-auto">
        {groupTreesByOrg(trees).map(([org, orgTrees]) => (
          <div key={org} className="mb-3">
            <div className="flex justify-between items-center px-2 py-0.5">
              <div className="text-zinc-600 text-[10px] uppercase tracking-wider">{org}</div>
              <span className="text-zinc-600 text-[10px]">{orgTrees.length}</span>
            </div>
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

      {/* Compact Status Bar */}
      <div className="mt-auto pt-3 border-t border-zinc-800/50">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <span>Broker</span>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${status?.broker === "running" ? "bg-emerald-400" : "bg-red-400"}`} />
          </div>
          <span>Workers {status?.workers ?? 0}</span>
          <span>Today ${(status?.cost.today ?? 0).toFixed(2)}</span>
          {status?.version && <span className="text-zinc-600">v{status.version}</span>}
        </div>
        {status?.remoteUrl && (
          <a
            href={status.remoteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1.5 text-[10px] text-emerald-500/50 hover:text-emerald-400 truncate"
          >
            {status.remoteUrl.replace("https://", "")}
          </a>
        )}
      </div>
    </aside>
  );
}
