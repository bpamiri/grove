import { useMemo } from "react";

interface TimelineEntry {
  task_id: string;
  title: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number;
  current_step: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  queued: "bg-zinc-500",
};

export default function ActivityTimeline({ data, rangeMs }: { data: TimelineEntry[]; rangeMs: number }) {
  const now = Date.now();
  const start = now - rangeMs;

  const bars = useMemo(() =>
    data
      .filter(t => t.started_at)
      .map(t => {
        const s = new Date(t.started_at).getTime();
        const e = t.completed_at ? new Date(t.completed_at).getTime() : now;
        const left = Math.max(0, ((s - start) / rangeMs) * 100);
        const width = Math.min(100 - left, ((e - s) / rangeMs) * 100);
        const durationSec = Math.floor((e - s) / 1000);
        const durationStr = durationSec < 60 ? `${durationSec}s` : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
        return { ...t, left, width, durationStr };
      })
      .filter(b => b.width > 0),
  [data, rangeMs, now]);

  if (bars.length === 0) return <div className="text-zinc-500 text-xs p-4">No activity in this range</div>;

  return (
    <div className="space-y-1.5">
      {bars.map(b => (
        <div key={b.task_id} className="flex items-center gap-2 text-xs">
          <span className="text-zinc-400 w-16 flex-shrink-0 truncate font-mono">{b.task_id}</span>
          <div className="flex-1 h-5 bg-zinc-900 rounded relative overflow-hidden">
            <div
              className={`absolute h-full rounded ${STATUS_COLORS[b.status] ?? "bg-zinc-600"} opacity-80`}
              style={{ left: `${b.left}%`, width: `${Math.max(b.width, 1)}%` }}
            />
            <span className="absolute inset-0 flex items-center px-2 text-[10px] text-white/80 truncate">
              {b.current_step ?? "—"} ({b.durationStr})
            </span>
          </div>
          <span className="text-zinc-500 w-14 text-right">${b.cost_usd.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
