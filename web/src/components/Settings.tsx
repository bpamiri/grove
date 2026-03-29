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
  const [restarting, setRestarting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<Record<string, string>>({});
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<string | null>(null);

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
            <div key={tree.id} className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{tree.name}</div>
                  <div className="text-xs text-zinc-500 font-mono mt-0.5">{tree.path}</div>
                  {tree.github && <div className="text-xs text-zinc-500 mt-0.5">{tree.github}</div>}
                </div>
                <div className="flex items-center gap-2">
                  {tree.github && (
                    <button
                      onClick={async () => {
                        setImporting(tree.id);
                        setImportResult(prev => ({ ...prev, [tree.id]: "" }));
                        try {
                          const res = await api<{ imported: number; skipped: number; total: number }>(
                            `/api/trees/${tree.id}/import-issues`,
                            { method: "POST" }
                          );
                          setImportResult(prev => ({
                            ...prev,
                            [tree.id]: `${res.imported} imported, ${res.skipped} skipped (${res.total} open)`,
                          }));
                          if (res.imported > 0) onRefresh();
                        } catch (err: any) {
                          setImportResult(prev => ({ ...prev, [tree.id]: `Error: ${err.message}` }));
                        } finally {
                          setImporting(null);
                        }
                      }}
                      disabled={importing === tree.id}
                      className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/30 px-3 py-1.5 rounded-md hover:bg-blue-500/25 disabled:opacity-50"
                    >
                      {importing === tree.id ? "Importing..." : "Import Issues"}
                    </button>
                  )}
                  <div className="text-xs text-zinc-600">{tree.branch_prefix}</div>
                </div>
              </div>
              {importResult[tree.id] && (
                <div className="text-xs text-zinc-500 mt-2 pt-2 border-t border-zinc-800">
                  {importResult[tree.id]}
                </div>
              )}
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
      <section className="mb-8">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">System</h3>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Workers" value={`${status?.workers ?? 0} active`} />
          <StatCard label="Queue" value={`${(status as any)?.queue ?? 0} pending`} />
          <StatCard label="Tasks" value={`${status?.tasks.total ?? 0} total`} />
          <StatCard label="WebSocket" value={`${status?.wsClients ?? 0} clients`} />
        </div>
      </section>

      {/* Actions */}
      <section>
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Actions</h3>
        <button
          onClick={async () => {
            setRestarting(true);
            try {
              await api("/api/restart", { method: "POST" });
            } catch { /* connection will drop during restart */ }
            // Poll until the server is back
            const poll = setInterval(async () => {
              try {
                await api("/api/status");
                clearInterval(poll);
                setRestarting(false);
                onRefresh();
              } catch { /* still restarting */ }
            }, 2000);
            // Give up after 30s
            setTimeout(() => { clearInterval(poll); setRestarting(false); }, 30000);
          }}
          disabled={restarting}
          className="bg-amber-500/15 text-amber-400 border border-amber-500/30 px-4 py-2.5 rounded-lg text-sm hover:bg-amber-500/25 disabled:opacity-50 flex items-center gap-2"
        >
          {restarting ? (
            <>
              <span className="animate-spin">&#8635;</span>
              Restarting...
            </>
          ) : (
            "Restart Grove"
          )}
        </button>
        <p className="text-xs text-zinc-600 mt-2">
          Stops and restarts the broker, orchestrator, and all workers. Orphaned tasks will auto-recover.
        </p>

        <div className="mt-4 pt-4 border-t border-zinc-800">
          <button
            onClick={async () => {
              setRotating(true);
              setRotateResult(null);
              try {
                const res = await api<{ ok: boolean; token: string; subdomain: string | null }>(
                  "/api/rotate-credentials",
                  { method: "POST" },
                );
                // Update stored token
                localStorage.setItem("grove-auth-token", res.token);
                setRotateResult("Credentials rotated. Restarting to apply new URL...");
                // Trigger restart to pick up new subdomain
                try { await api("/api/restart", { method: "POST" }); } catch {}
                // Poll until back
                const poll = setInterval(async () => {
                  try {
                    await api("/api/status");
                    clearInterval(poll);
                    setRotating(false);
                    setRotateResult("Done — new URL and token are active.");
                    onRefresh();
                  } catch {}
                }, 2000);
                setTimeout(() => { clearInterval(poll); setRotating(false); }, 30000);
              } catch (err: any) {
                setRotateResult(`Error: ${err.message}`);
                setRotating(false);
              }
            }}
            disabled={rotating || restarting}
            className="bg-red-500/15 text-red-400 border border-red-500/30 px-4 py-2.5 rounded-lg text-sm hover:bg-red-500/25 disabled:opacity-50 flex items-center gap-2"
          >
            {rotating ? (
              <>
                <span className="animate-spin">&#8635;</span>
                Rotating...
              </>
            ) : (
              "Rotate Credentials"
            )}
          </button>
          <p className="text-xs text-zinc-600 mt-2">
            Generates a new tunnel URL and auth token. Use after sharing your screen or recording a demo.
          </p>
          {rotateResult && (
            <p className="text-xs text-emerald-400/80 mt-2">{rotateResult}</p>
          )}
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
