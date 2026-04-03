import { useState } from "react";
import { api } from "../api/client";
import type { Task, Tree } from "../hooks/useTasks";
import Pipeline from "./Pipeline";
import TaskForm from "./TaskForm";
import SeedChat from "./SeedChat";
import type { Seed, SeedMessage } from "../hooks/useSeed";
import WorkerActivityFeed from "./WorkerActivityFeed";
import VerdictPanel from "./VerdictPanel";

interface PathInfo {
  description: string;
  steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }>;
}

interface Props {
  task: Task;
  activityLog?: Array<{ ts: number; msg: string; kind?: string }>;
  steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }>;
  send: (data: any) => void;
  trees: Tree[];
  paths: Record<string, PathInfo>;
  allTasks: Task[];
  onRefresh: () => void;
  seed?: Seed | null;
  seedMessages?: SeedMessage[];
  seedActive?: boolean;
  seedComplete?: boolean;
  seedContainerRef?: React.RefObject<HTMLDivElement | null>;
  onSeedSend?: (text: string) => void;
  onSeedStart?: () => void;
  onSeedStop?: () => void;
  onSeedDiscard?: () => void;
  seedStreamingText?: string;
  seedStage?: string | null;
  seedBranches?: Array<{ id: string; label?: string; parentMessageIndex: number }>;
  seedActiveBranch?: string;
}

export default function TaskDetail({ task, activityLog, steps, send, trees, paths, allTasks, onRefresh, seed, seedMessages, seedActive, seedComplete, seedContainerRef, onSeedSend, onSeedStart, onSeedStop, onSeedDiscard, seedStreamingText, seedStage, seedBranches, seedActiveBranch }: Props) {
  const gateResults = task.gate_results ? JSON.parse(task.gate_results) : null;
  const filesModified = task.files_modified?.split("\n").filter(Boolean) ?? [];
  const [resumeStep, setResumeStep] = useState(task.current_step ?? steps[0]?.id ?? "");
  const canResume = task.status === "failed" || (task.status === "active" && !!task.paused);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="mt-1">
        <TaskForm
          trees={trees}
          paths={paths}
          allTasks={allTasks}
          editTask={task}
          onSave={() => { setEditing(false); onRefresh(); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 mt-1 text-sm space-y-4">
      {/* Status bar */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs border-b border-zinc-800 pb-3">
        <Field label="Status" value={task.status} />
        <Field label="Tree" value={task.tree_id ?? "none"} />
        <Field label="Path" value={task.path_name} />
        <Field label="Priority" value={task.priority === 2 ? "High" : task.priority === 1 ? "Medium" : "Low"} />
        <Field label="Cost" value={`$${task.cost_usd.toFixed(2)}`} />
        {task.started_at && <Field label="Time" value={timeSince(task.started_at)} />}
        {task.branch && <Field label="Branch" value={task.branch} mono />}
        {task.depends_on && <Field label="Depends on" value={task.depends_on} mono />}
        {task.max_retries !== 2 && <Field label="Max retries" value={String(task.max_retries)} />}
        {task.github_issue && <Field label="Issue" value={`#${task.github_issue}`} mono />}
      </div>

      {/* Labels */}
      {task.labels && (
        <div className="flex flex-wrap gap-1.5 -mt-2">
          {task.labels.split(",").map((label) => (
            <span key={label} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
              {label.trim()}
            </span>
          ))}
        </div>
      )}

      {/* Pipeline */}
      <div>
        <Label>Pipeline</Label>
        <Pipeline task={task} steps={steps} />
      </div>

      {/* Activity feed — live when running, summary when complete, idle when draft/queued */}
      <WorkerActivityFeed
        log={activityLog ?? []}
        taskStatus={task.status}
        paused={!!task.paused}
        since={task.started_at}
        costUsd={task.cost_usd}
      />

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
            containerRef={seedContainerRef ?? { current: null }}
            taskId={task.id}
            taskTitle={task.title}
            streamingText={seedStreamingText}
            stage={seedStage}
            branches={seedBranches}
            activeBranch={seedActiveBranch}
            wsSend={send}
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
            containerRef={{ current: null }}
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

      {/* Verdict panel for PR review tasks awaiting decision */}
      {task.status === "waiting" && task.source_pr && (
        <div>
          <Label>Verdict</Label>
          <VerdictPanel task={task} onAction={() => window.location.reload()} />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800 items-center">
        <ActionButton label="Edit" onClick={() => setEditing(true)} />
        {task.status === "active" && !task.paused && (
          <ActionButton label="Pause" onClick={() => send({ type: "action", action: "pause_task", taskId: task.id })} />
        )}
        {task.status !== "completed" && task.status !== "failed" && task.status !== "closed" && (
          <ActionButton label="Cancel" variant="danger" onClick={() => send({ type: "action", action: "cancel_task", taskId: task.id })} />
        )}
        {(task.status === "draft" || task.status === "failed") && (
          <ActionButton label="Close" variant="muted" onClick={() => send({ type: "action", action: "close_task", taskId: task.id })} />
        )}
        {task.status === "draft" && (
          <ActionButton label="Delete" variant="danger" onClick={async () => {
            if (!confirm("Permanently delete this draft task?")) return;
            try { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); onRefresh(); } catch {}
          }} />
        )}
        {canResume && steps.length > 0 && (
          <>
            <select
              value={resumeStep}
              onChange={(e) => setResumeStep(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-emerald-500/50"
            >
              {steps.map((s) => (
                <option key={s.id} value={s.id}>{s.label ?? s.id}</option>
              ))}
            </select>
            <ActionButton
              label="Resume"
              onClick={() => send({ type: "action", action: "resume_task", taskId: task.id, step: resumeStep })}
            />
          </>
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

function ActionButton({ label, variant, onClick }: { label: string; variant?: "danger" | "muted"; onClick?: () => void }) {
  const cls = variant === "danger"
    ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
    : variant === "muted"
      ? "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700";
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded text-xs ${cls}`}>
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
