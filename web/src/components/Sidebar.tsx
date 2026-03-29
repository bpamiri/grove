import { useState } from "react";
import type { Tree, Status } from "../hooks/useTasks";

/** Group trees by org, derived from github field (owner/repo) or path (~/GitHub/{org}/...) */
function groupTreesByOrg(trees: Tree[]): [string, Tree[]][] {
  const groups = new Map<string, Tree[]>();
  for (const tree of trees) {
    let org = "other";
    if (tree.github) {
      org = tree.github.split("/")[0];
    } else {
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
  onDashboardClick?: () => void;
}

export default function Sidebar({ trees, status, taskCount, selectedTree, onSelectTree, connected, onSettingsClick, onDashboardClick }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleOrg = (org: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(org)) next.delete(org);
      else next.add(org);
      return next;
    });
  };

  return (
    <aside className="h-full flex flex-col bg-zinc-900/50 p-4 text-sm overflow-y-auto">
      {/* Logo + Settings gear */}
      <div className="flex justify-between items-center mb-6">
        <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest">
          Grove
        </div>
        <div className="flex items-center gap-2">
          {onDashboardClick && (
            <button
              onClick={onDashboardClick}
              className="text-zinc-600 hover:text-zinc-400 text-base leading-none"
              title="Dashboard"
            >
              &#9776;
            </button>
          )}
          <button
            onClick={onSettingsClick}
            className="text-zinc-600 hover:text-zinc-400 text-base leading-none"
            title="Settings"
          >
            &#9881;
          </button>
        </div>
      </div>

      {/* All Tasks */}
      <button
        onClick={() => onSelectTree(null)}
        className={`w-full text-left px-2.5 py-1.5 rounded-md text-sm flex justify-between items-center mb-3 ${
          selectedTree === null ? "bg-emerald-400/10 text-emerald-400" : "text-zinc-400 hover:text-zinc-200"
        }`}
      >
        <span>All Tasks</span>
        <span className="text-[11px] opacity-70">{taskCount}</span>
      </button>

      {/* Trees grouped by org — collapsible */}
      <div className="flex-1 mb-4">
        {groupTreesByOrg(trees).map(([org, orgTrees]) => {
          const isCollapsed = collapsed.has(org);
          return (
            <div key={org} className="mb-1">
              <button
                onClick={() => toggleOrg(org)}
                className="w-full flex items-center gap-1 px-2 py-1 text-zinc-600 hover:text-zinc-400 text-[11px] uppercase tracking-wider"
              >
                <span className="text-[8px] text-zinc-600">{isCollapsed ? "\u25b6" : "\u25bc"}</span>
                <span className="flex-1 text-left">{org}</span>
                <span className="text-[10px] text-zinc-700">{orgTrees.length}</span>
              </button>
              {!isCollapsed && (
                <div className="pl-2">
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
              )}
            </div>
          );
        })}
        {trees.length === 0 && (
          <div className="text-zinc-600 text-xs px-2 py-1">No trees configured</div>
        )}
      </div>

      {/* System Status — compact */}
      <div className="mt-auto border-t border-zinc-800 pt-3">
        <div className="space-y-1 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>Broker</span>
            <span className={status?.broker === "running" ? "text-emerald-400" : "text-red-400"}>&#9679;</span>
          </div>
          <div className="flex justify-between">
            <span>Workers</span>
            <span>{status?.workers ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span>Today</span>
            <span>${(status?.cost.today ?? 0).toFixed(2)}</span>
          </div>
          {status?.remoteUrl && (
            <div className="mt-2 pt-2 border-t border-zinc-800">
              <div className="flex items-start gap-1">
                <a
                  href={status.remoteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-500/70 hover:text-emerald-400 break-all text-[10px] flex-1"
                >
                  {status.remoteUrl.replace("https://", "")}
                </a>
                <CopyButton url={status.remoteUrl} />
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const token = localStorage.getItem("grove-auth-token");
    const fullUrl = token ? `${url}?token=${token}` : url;
    await navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="text-zinc-600 hover:text-emerald-400 flex-shrink-0 transition-colors"
      title="Copy URL with auth token"
    >
      {copied ? (
        <span className="text-emerald-400 text-[10px]">✓</span>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
        </svg>
      )}
    </button>
  );
}
