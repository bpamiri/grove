import { useState, useCallback } from "react";
import { api } from "../api/client";

interface TaskAnalysis {
  taskId: string;
  title: string;
  predictedFiles: string[];
  confidence: "high" | "medium" | "low";
}

interface OverlapEntry {
  taskA: string;
  taskB: string;
  sharedFiles: string[];
}

interface ExecutionWave {
  wave: number;
  taskIds: string[];
}

interface Plan {
  treeId: string;
  tasks: TaskAnalysis[];
  overlaps: OverlapEntry[];
  waves: ExecutionWave[];
}

interface Props {
  treeId: string;
  onClose: () => void;
  onRefresh: () => void;
}

const CONFIDENCE_COLORS = {
  high: "text-emerald-400",
  medium: "text-yellow-400",
  low: "text-red-400",
};

export default function BatchPlan({ treeId, onClose, onRefresh }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchedWave, setDispatchedWave] = useState<number | null>(null);
  const [mode, setMode] = useState<"heuristic" | "agent" | "hybrid">("heuristic");

  const analyze = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Plan>("/api/batch/analyze", {
        method: "POST",
        body: JSON.stringify({ treeId, mode }),
      });
      setPlan(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [treeId, mode]);

  const dispatchWave = useCallback(async (wave: number) => {
    setDispatching(true);
    setError(null);
    try {
      await api("/api/batch/dispatch", {
        method: "POST",
        body: JSON.stringify({ treeId, wave }),
      });
      setDispatchedWave(wave);
      onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDispatching(false);
    }
  }, [treeId, onRefresh]);

  return (
    <div className="p-4 bg-zinc-900/80 border border-zinc-700 rounded-lg space-y-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-zinc-200">Batch Planner</h3>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 text-xs"
        >
          Close
        </button>
      </div>

      {/* Analyze button with mode toggle */}
      {!plan && !loading && (
        <div className="space-y-2">
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setMode("heuristic")}
              className={`px-2 py-1 rounded ${mode === "heuristic" ? "bg-zinc-600 text-zinc-200" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              Fast
            </button>
            <button
              onClick={() => setMode("hybrid")}
              className={`px-2 py-1 rounded ${mode === "hybrid" ? "bg-zinc-600 text-zinc-200" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              Hybrid
            </button>
            <button
              onClick={() => setMode("agent")}
              className={`px-2 py-1 rounded ${mode === "agent" ? "bg-emerald-500/30 text-emerald-400" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              AI-Assisted
            </button>
          </div>
          <button
            onClick={analyze}
            className="w-full bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg hover:bg-emerald-500/30 text-sm font-medium"
          >
            Analyze Draft Tasks
          </button>
        </div>
      )}

      {loading && (
        <div className="text-center text-zinc-500 text-sm py-4">
          Analyzing tasks...
        </div>
      )}

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {/* Results */}
      {plan && plan.tasks.length === 0 && (
        <div className="text-zinc-500 text-sm">No draft tasks found for this tree.</div>
      )}

      {plan && plan.tasks.length > 0 && (
        <>
          {/* Task Analysis */}
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
              File Predictions ({plan.tasks.length} tasks)
            </h4>
            <div className="space-y-2">
              {plan.tasks.map((t) => (
                <div key={t.taskId} className="text-xs bg-zinc-800/50 rounded p-2">
                  <div className="flex justify-between items-start">
                    <span className="font-mono text-zinc-300">{t.taskId}</span>
                    <span className={`${CONFIDENCE_COLORS[t.confidence]} text-[10px]`}>
                      {t.confidence}
                    </span>
                  </div>
                  <div className="text-zinc-400 mt-0.5 truncate">{t.title}</div>
                  {t.predictedFiles.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.predictedFiles.map((f) => (
                        <span key={f} className="bg-zinc-700/50 text-zinc-400 px-1.5 py-0.5 rounded text-[10px] font-mono">
                          {f.split("/").pop()}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Overlap Matrix */}
          {plan.overlaps.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
                File Overlap ({plan.overlaps.length} pair{plan.overlaps.length > 1 ? "s" : ""})
              </h4>
              <div className="space-y-1">
                {plan.overlaps.map((o, i) => (
                  <div key={i} className="text-xs flex items-center gap-2">
                    <span className="font-mono text-zinc-300">{o.taskA}</span>
                    <span className="text-zinc-600">×</span>
                    <span className="font-mono text-zinc-300">{o.taskB}</span>
                    <span className="text-zinc-500">—</span>
                    <span className="text-yellow-400/80">
                      {o.sharedFiles.map(f => f.split("/").pop()).join(", ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Execution Waves */}
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
              Execution Waves
            </h4>
            <div className="space-y-2">
              {plan.waves.map((w) => {
                const isDispatched = dispatchedWave !== null && w.wave <= dispatchedWave;
                return (
                  <div
                    key={w.wave}
                    className={`flex items-center justify-between text-xs rounded p-2 ${
                      isDispatched
                        ? "bg-emerald-500/10 border border-emerald-500/20"
                        : w.wave === 1
                          ? "bg-zinc-800/80 border border-zinc-700"
                          : "bg-zinc-800/30 border border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`font-medium ${
                        isDispatched ? "text-emerald-400" : "text-zinc-300"
                      }`}>
                        Wave {w.wave}
                      </span>
                      <span className="text-zinc-500">
                        {w.taskIds.length > 1 ? "parallel" : "single"}
                      </span>
                      <span className="font-mono text-zinc-400">
                        {w.taskIds.join(", ")}
                      </span>
                    </div>
                    {w.wave === (dispatchedWave ?? 0) + 1 && !dispatching && (
                      <button
                        onClick={() => dispatchWave(w.wave)}
                        className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded hover:bg-emerald-500/30"
                      >
                        Dispatch
                      </button>
                    )}
                    {isDispatched && (
                      <span className="text-emerald-500 text-[10px]">dispatched</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {dispatching && (
            <div className="text-center text-zinc-500 text-sm py-2">
              Dispatching...
            </div>
          )}
        </>
      )}
    </div>
  );
}
