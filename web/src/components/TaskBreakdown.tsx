interface StepDuration {
  step: string;
  durationMs: number;
  type: string;
}

const TYPE_COLORS: Record<string, string> = {
  worker: "bg-blue-500",
  gate: "bg-amber-500",
  merge: "bg-emerald-500",
  review: "bg-purple-500",
  verdict: "bg-zinc-500",
};

export default function TaskBreakdown({ steps, totalCost }: { steps: StepDuration[]; totalCost: number }) {
  const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
  if (totalMs === 0) return <div className="text-zinc-500 text-xs">No step data</div>;

  return (
    <div className="space-y-1">
      {steps.map((s, i) => {
        const pct = (s.durationMs / totalMs) * 100;
        const sec = Math.floor(s.durationMs / 1000);
        const label = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="text-zinc-400 w-20 truncate">{s.step}</span>
            <div className="flex-1 h-4 bg-zinc-900 rounded overflow-hidden">
              <div className={`h-full ${TYPE_COLORS[s.type] ?? "bg-zinc-600"} rounded`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-zinc-500 w-12 text-right">{label}</span>
          </div>
        );
      })}
      <div className="text-zinc-500 text-[10px] text-right mt-1">
        Total: {Math.floor(totalMs / 1000)}s | ${totalCost.toFixed(2)}
      </div>
    </div>
  );
}
