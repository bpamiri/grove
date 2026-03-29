import { useEffect, useRef } from "react";
import type { Task } from "../hooks/useTasks";
import Pipeline from "./Pipeline";
import type { PathStep } from "./Pipeline";
import SeedChat from "./SeedChat";
import type { Seed, SeedMessage } from "../hooks/useSeed";
import ActivityIndicator from "./ActivityIndicator";

interface Props {
  task: Task;
  activityLog?: Array<{ ts: number; msg: string }>;
  steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }>;
  seed?: Seed | null;
  seedMessages?: SeedMessage[];
  seedActive?: boolean;
  seedComplete?: boolean;
  seedBottomRef?: React.RefObject<HTMLDivElement | null>;
  onSeedSend?: (text: string) => void;
  onSeedStart?: () => void;
  onSeedStop?: () => void;
  onSeedDiscard?: () => void;
}

export default function TaskDetail({ task, activityLog, steps, seed, seedMessages, seedActive, seedComplete, seedBottomRef, onSeedSend, onSeedStart, onSeedStop, onSeedDiscard }: Props) {
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
        <Pipeline task={task} steps={steps} />
      </div>

      {/* Activity feed — live when running, historical for completed/failed */}
      {((activityLog ?? []).length > 0 || (task.status === "active" && !task.paused)) && (
        <ActivityFeed log={activityLog ?? []} live={task.status === "active" && !task.paused} since={task.started_at} />
      )}

      {/* Description */}
      {task.description && (
        <div>
          <Label>Description</Label>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-48 overflow-y-auto text-sm text-zinc-400 whitespace-pre-wrap">{task.description}</div>
        </div>
      )}

      {/* Seed — brainstorming */}
      {task.status === "draft" && onSeedStart && (
        <div>
          <Label>Brainstorm</Label>
          <SeedChat
            seed={seed ?? null}
            messages={seedMessages ?? []}
            isActive={seedActive ?? false}
            isSeeded={seedComplete ?? false}
            bottomRef={seedBottomRef ?? { current: null }}
            onSend={onSeedSend ?? (() => {})}
            onStart={onSeedStart}
            onStop={onSeedStop ?? (() => {})}
            onDiscard={onSeedDiscard ?? (() => {})}
          />
        </div>
      )}

      {/* Show completed seed on non-draft tasks too */}
      {task.status !== "draft" && seedComplete && (
        <div>
          <Label>Seed</Label>
          <SeedChat
            seed={seed ?? null}
            messages={[]}
            isActive={false}
            isSeeded={true}
            bottomRef={{ current: null }}
            onSend={() => {}}
            onStart={() => {}}
            onStop={() => {}}
            onDiscard={() => {}}
          />
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
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-48 overflow-y-auto text-xs text-zinc-400 whitespace-pre-wrap">{task.session_summary}</div>
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
        {task.status === "active" && !task.paused && (
          <ActionButton label="Pause" />
        )}
        {task.status !== "completed" && task.status !== "failed" && (
          <ActionButton label="Cancel" variant="danger" />
        )}
      </div>
    </div>
  );
}

function ActivityFeed({ log, live, since }: { log: Array<{ ts: number; msg: string }>; live?: boolean; since?: string | null }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log.length]);

  return (
    <div>
      <Label>{live ? "Live Activity" : "Activity Log"}</Label>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {log.length === 0 && live && (
          <div className="text-blue-400/70 text-center py-3">
            <ActivityIndicator since={since} label="Waiting for activity" size="md" />
          </div>
        )}
        {log.map((entry, i) => {
          const time = new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return (
            <div key={i} className="flex gap-2 hover:bg-zinc-900/50 px-1 rounded">
              <span className="text-zinc-600 flex-shrink-0">{time}</span>
              <span className={`${activityColor(entry.msg)} break-all`}>{entry.msg}</span>
            </div>
          );
        })}
        {log.length > 0 && live && (
          <div className="text-blue-400/60 px-1 pt-1">
            <ActivityIndicator since={log[log.length - 1]?.ts} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function activityColor(msg: string): string {
  if (msg.startsWith("thinking:")) return "text-purple-400/70 italic";
  if (msg.startsWith("Read") || msg.startsWith("Grep") || msg.startsWith("Glob")) return "text-zinc-400";
  if (msg.startsWith("Edit") || msg.startsWith("Write")) return "text-amber-400";
  if (msg.startsWith("Bash")) return "text-cyan-400";
  // Text output from Claude (not a tool call)
  if (!msg.includes(":") || msg.indexOf(":") > 20) return "text-zinc-300/80";
  return "text-zinc-300";
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

function ActionButton({ label, variant }: { label: string; variant?: "danger" }) {
  return (
    <button
      className={`px-3 py-1.5 rounded text-xs ${
        variant === "danger"
          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
      }`}
    >
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
