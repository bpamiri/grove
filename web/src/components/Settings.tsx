import { useState } from "react";
import { api } from "../api/client";
import type { SkillManifest } from "../api/client";
import type { Tree, Status } from "../hooks/useTasks";

interface Props {
  trees: Tree[];
  status: Status | null;
  onRefresh: () => void;
  skills: SkillManifest[];
  skillsLoading: boolean;
  onInstallSkill: (source: string) => Promise<{ ok: boolean; name: string }>;
  onRemoveSkill: (name: string) => Promise<void>;
}

export default function Settings({ trees, status, onRefresh, skills, skillsLoading, onInstallSkill, onRemoveSkill }: Props) {
  const [newTreePath, setNewTreePath] = useState("");
  const [newTreeGithub, setNewTreeGithub] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<Record<string, string>>({});
  const [importingPrs, setImportingPrs] = useState<string | null>(null);
  const [importPrResult, setImportPrResult] = useState<Record<string, string>>({});
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<string | null>(null);
  const [skillSource, setSkillSource] = useState("");
  const [installingSkill, setInstallingSkill] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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

  const importPrs = async (treeId: string) => {
    setImportingPrs(treeId);
    setImportPrResult(prev => ({ ...prev, [treeId]: "" }));
    try {
      const res = await api<{ imported: number; skipped: number; total: number }>(
        `/api/trees/${treeId}/import-prs`,
        { method: "POST" }
      );
      setImportPrResult(prev => ({
        ...prev,
        [treeId]: `${res.imported} imported, ${res.skipped} skipped (${res.total} open)`,
      }));
      if (res.imported > 0) onRefresh();
    } catch (err: any) {
      setImportPrResult(prev => ({ ...prev, [treeId]: `Error: ${err.message}` }));
    } finally {
      setImportingPrs(null);
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
                    <>
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
                      <button
                        onClick={() => importPrs(tree.id)}
                        disabled={importingPrs === tree.id}
                        className="text-xs px-2 py-1 rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-50"
                      >
                        {importingPrs === tree.id ? "Importing..." : "Import PRs"}
                      </button>
                    </>
                  )}
                  <div className="text-xs text-zinc-600">{tree.branch_prefix}</div>
                </div>
              </div>
              {importResult[tree.id] && (
                <div className="text-xs text-zinc-500 mt-2 pt-2 border-t border-zinc-800">
                  {importResult[tree.id]}
                </div>
              )}
              {importPrResult[tree.id] && (
                <div className="text-xs text-zinc-500 mt-2 pt-2 border-t border-zinc-800">
                  {importPrResult[tree.id]}
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

      {/* Skills */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Skills Library</h3>

        {skillsLoading ? (
          <div className="text-zinc-600 text-sm">Loading skills...</div>
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {skills.map((skill) => (
                <div key={skill.name} className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{skill.name}</span>
                        <span className="text-xs text-zinc-600">v{skill.version}</span>
                      </div>
                      <div className="text-xs text-zinc-500 mt-0.5 truncate">{skill.description}</div>
                      {skill.author && (
                        <div className="text-xs text-zinc-600 mt-0.5">by {skill.author}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <span className="text-xs text-zinc-600">{skill.files.length} file{skill.files.length !== 1 ? "s" : ""}</span>
                      {confirmRemove === skill.name ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={async () => {
                              setRemovingSkill(skill.name);
                              setConfirmRemove(null);
                              try {
                                await onRemoveSkill(skill.name);
                              } catch (err: any) {
                                setSkillError(err.message);
                              } finally {
                                setRemovingSkill(null);
                              }
                            }}
                            disabled={removingSkill === skill.name}
                            className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded hover:bg-red-500/30 disabled:opacity-50"
                          >
                            {removingSkill === skill.name ? "..." : "Confirm"}
                          </button>
                          <button
                            onClick={() => setConfirmRemove(null)}
                            className="text-xs text-zinc-500 px-2 py-1 rounded hover:text-zinc-400"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRemove(skill.name)}
                          className="text-xs text-zinc-500 px-2 py-1 rounded hover:text-red-400 hover:bg-red-500/10"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                  {skill.suggested_steps && skill.suggested_steps.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-zinc-800">
                      <div className="text-xs text-zinc-600">Suggested steps: {skill.suggested_steps.join(", ")}</div>
                    </div>
                  )}
                </div>
              ))}
              {skills.length === 0 && (
                <div className="text-zinc-600 text-sm">No skills installed.</div>
              )}
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!skillSource.trim()) return;
                setInstallingSkill(true);
                setSkillError(null);
                try {
                  await onInstallSkill(skillSource.trim());
                  setSkillSource("");
                } catch (err: any) {
                  setSkillError(err.message);
                } finally {
                  setInstallingSkill(false);
                }
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={skillSource}
                onChange={(e) => setSkillSource(e.target.value)}
                placeholder="Local path or Git URL"
                className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                type="submit"
                disabled={installingSkill || !skillSource.trim()}
                className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
              >
                {installingSkill ? "Installing..." : "Install"}
              </button>
            </form>
            {skillError && (
              <div className="text-xs text-red-400 mt-2">{skillError}</div>
            )}
          </>
        )}
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
