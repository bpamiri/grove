import type { Task } from "../hooks/useTasks";
import Pipeline from "./Pipeline";
import { ActivityIndicator } from "./ActivityIndicator";

interface Props {
  task: Task;
  activity?: string;
  send: (data: any) => void;
}

export default function TaskDetail({ task, activity, send }: Props) {
  const gateResults = task.gate_results ? JSON.parse(task.gate_results) : null;
  const filesModified = task.files_modified?.split("\n").filter(Boolean) ?? [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 mt-1 text-sm space-y-4">
      {/* Status bar */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs border-b border-zinc-800 pb-3">
        <Field label="Status" value={task.status} />
        <Field label="Tree" value={task.tree_id ?? "none"} />
        <Field label="Path" value={task.path_name} />
        <Field label="Cost" value={`$${task.cost_usd.toFixed(2)}`} />
        {task.started_at && <Field label="Time" value={timeSince(task.started_at)} />}
        {task.branch && <Field label="Branch" value={task.branch} mono />}
      </div>

      {/* Pipeline */}
      <div>
        <Label>Pipeline</Label>
        <Pipeline pathName={task.path_name} status={task.status} />
      </div>

      {/* Live activity */}
      {task.status === "running" && (
        <div>
          <Label>Activity</Label>
          <div className="text-xs text-blue-400">
            <ActivityIndicator
              label={activity ?? "working..."}
              since={task.started_at}
            />
          </div>
        </div>
      )}

      {/* Description */}
      {task.description && (
        <div>
          <Label>Description</Label>
          <p className="text-zinc-400">{task.description}</p>
        </div>
      )}

      {/* Files modified */}
      {filesModified.length > 0 && (
        <div>
          <Label>Files Modified</Label>
          <div className="space-y-0.5 font-mono text-xs">
            {filesModified.map((f) => (
              <div key={f} className="text-zinc-400">{f}</div>
            ))}
          </div>
        </div>
      )}

      {/* Gate results */}
      {gateResults && Array.isArray(gateResults) && (
        <div>
          <Label>Quality Gates</Label>
          <div className="space-y-1">
            {gateResults.map((g: any) => (
              <div
                key={g.gate}
                className={`flex justify-between items-center px-3 py-1.5 rounded text-xs ${
                  g.passed ? "bg-emerald-900/20" : "bg-red-900/20"
                }`}
              >
                <span>{g.gate}</span>
                <span className={g.passed ? "text-emerald-400" : "text-red-400"}>
                  {g.passed ? "\u2713" : "\u2717"} {g.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session summary */}
      {task.session_summary && (
        <div>
          <Label>Session Summary</Label>
          <p className="text-zinc-400 text-xs whitespace-pre-wrap">{task.session_summary}</p>
        </div>
      )}

      {/* PR link */}
      {task.pr_url && (
        <div>
          <a
            href={task.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 text-xs hover:underline"
          >
            PR #{task.pr_number} &rarr;
          </a>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-2 border-t border-zinc-800">
        {task.status === "running" && (
          <ActionButton
            label="Pause"
            onClick={() => send({ type: "action", action: "pause_task", taskId: task.id })}
          />
        )}
        {(task.status === "conflict" || task.status === "ci_failed") && (
          <ActionButton
            label="Retry Merge"
            variant="warning"
            onClick={() => send({ type: "action", action: "retry_merge", taskId: task.id })}
          />
        )}
        {!["completed", "merged", "failed"].includes(task.status) && (
          <ActionButton
            label="Cancel"
            variant="danger"
            onClick={() => send({ type: "action", action: "cancel_task", taskId: task.id })}
          />
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-zinc-500 uppercase text-[10px]">{label}</div>
      <div className={`mt-0.5 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <div className="text-zinc-500 text-xs uppercase mb-1.5">{children}</div>;
}

function ActionButton({ label, variant, onClick }: { label: string; variant?: "danger" | "warning"; onClick?: () => void }) {
  const colors = variant === "danger"
    ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
    : variant === "warning"
      ? "bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700";
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded text-xs ${colors}`}>
      {label}
    </button>
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
