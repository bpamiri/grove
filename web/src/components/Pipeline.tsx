// Visual step tracker for task workflow paths

const DEFAULT_STEPS = ["plan", "implement", "evaluate", "merge"];

const PATH_STEPS: Record<string, string[]> = {
  development: ["plan", "implement", "evaluate", "merge"],
  research: ["plan", "research", "report"],
  content: ["plan", "implement", "evaluate", "publish"],
};

// Map task status to the currently active step
function activeStep(status: string): string | null {
  switch (status) {
    case "planned":
    case "ready": return "plan";
    case "running": return "implement";
    case "done":
    case "evaluating": return "evaluate";
    case "ci_failed":
    case "conflict":
    case "merged":
    case "completed": return "merge";
    default: return null;
  }
}

function stepState(step: string, activeIdx: number, stepIdx: number): "done" | "active" | "pending" {
  if (stepIdx < activeIdx) return "done";
  if (stepIdx === activeIdx) return "active";
  return "pending";
}

interface Props {
  pathName: string;
  status: string;
}

export default function Pipeline({ pathName, status }: Props) {
  const steps = PATH_STEPS[pathName] ?? DEFAULT_STEPS;
  const active = activeStep(status);
  const activeIdx = active ? steps.indexOf(active) : -1;

  // If status is completed/merged, all steps are done
  const allDone = ["merged", "completed"].includes(status);
  const isConflict = status === "conflict";
  const isCiFailed = status === "ci_failed";

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => {
        const state = allDone ? "done" : stepState(step, activeIdx, i);
        const isErrorStep = state === "active" && (isConflict || isCiFailed);
        return (
          <div key={step} className="flex items-center gap-1">
            {i > 0 && <div className="text-zinc-700 text-xs">&rarr;</div>}
            <div
              className={`px-2 py-0.5 rounded text-xs ${
                state === "done"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : isErrorStep && isConflict
                    ? "bg-orange-500/20 text-orange-400 font-medium"
                    : isErrorStep && isCiFailed
                      ? "bg-red-500/20 text-red-400 font-medium"
                      : state === "active"
                        ? "bg-blue-500/20 text-blue-400 font-medium"
                        : "bg-zinc-800/50 text-zinc-600"
              }`}
            >
              {state === "done" && "\u2713 "}
              {state === "active" && !isErrorStep && "\u25cf "}
              {isErrorStep && "\u2717 "}
              {step}
            </div>
          </div>
        );
      })}
    </div>
  );
}
