// Visual step tracker for task workflow paths
import type { Task } from "../hooks/useTasks";

export interface PathStep {
  id: string;
  type: string;
  label: string;
  on_success: string;
  on_failure: string;
}

interface Props {
  task: Task;
  steps: PathStep[];
}

type StepVisual = "done" | "active" | "paused" | "failed" | "pending";

function resolveVisual(step: PathStep, stepIdx: number, task: Task, steps: PathStep[]): StepVisual {
  const currentIdx = steps.findIndex(s => s.id === task.current_step);

  if (task.current_step === "$done") return "done";
  if (task.current_step === "$fail") {
    return stepIdx < task.step_index ? "done" : stepIdx === task.step_index ? "failed" : "pending";
  }
  if (task.status === "draft" || task.status === "queued") return "pending";
  if (currentIdx === -1) return "pending";
  if (step.id === task.current_step) {
    if (task.paused) return "paused";
    if (task.status === "failed") return "failed";
    return "active";
  }
  if (stepIdx < currentIdx) return "done";
  return "pending";
}

const VISUAL_STYLES: Record<StepVisual, { bg: string; text: string; icon: string }> = {
  done:    { bg: "bg-emerald-500/15 border-emerald-500/30", text: "text-emerald-400", icon: "\u2713 " },
  active:  { bg: "bg-blue-500/20 border-blue-500/40 shadow-[0_0_8px_rgba(59,130,246,0.2)]", text: "text-blue-400 font-semibold", icon: "\u25cf " },
  paused:  { bg: "bg-amber-500/12 border-amber-500/40", text: "text-amber-300", icon: "\u23f8 " },
  failed:  { bg: "bg-red-500/12 border-red-500/40", text: "text-red-400", icon: "\u2717 " },
  pending: { bg: "bg-zinc-800/50 border-zinc-700/50", text: "text-zinc-600", icon: "\u25cf " },
};

export default function Pipeline({ task, steps }: Props) {
  if (steps.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => {
        const visual = resolveVisual(step, i, task, steps);
        const style = VISUAL_STYLES[visual];
        const currentIdx = steps.findIndex(s => s.id === task.current_step);
        return (
          <div key={step.id} className="flex items-center gap-1">
            {i > 0 && (
              <div className={`w-4 h-0.5 ${i <= currentIdx && task.current_step !== "$fail" ? "bg-emerald-500/40" : "bg-zinc-700"}`} />
            )}
            <div className={`px-2 py-0.5 rounded text-xs border ${style.bg} ${style.text}`}>
              {style.icon}{step.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Static preview of path steps — no task state, all steps shown with type-based styling */
export function PipelinePreview({ steps }: { steps: Array<{ id: string; label?: string; type?: string }> }) {
  if (steps.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => (
        <div key={`${step.id}-${i}`} className="flex items-center gap-1">
          {i > 0 && <div className="w-4 h-0.5 bg-zinc-700" />}
          <div className={`px-2 py-0.5 rounded text-xs border ${
            step.type === "verdict"
              ? "bg-purple-500/12 border-purple-500/30 text-purple-400"
              : "bg-zinc-800/50 border-zinc-700/50 text-zinc-400"
          }`}>
            {step.type === "verdict" ? "\u25c6 " : "\u25cf "}
            {step.label || step.id.charAt(0).toUpperCase() + step.id.slice(1)}
          </div>
        </div>
      ))}
    </div>
  );
}
