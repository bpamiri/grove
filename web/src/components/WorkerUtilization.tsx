interface UtilizationBucket {
  bucket: string;
  active_workers: number;
}

export default function WorkerUtilization({ data, maxWorkers }: { data: UtilizationBucket[]; maxWorkers: number }) {
  if (data.length === 0) return <div className="text-zinc-500 text-xs p-4">No utilization data</div>;

  const max = Math.max(maxWorkers, ...data.map(d => d.active_workers));

  return (
    <div className="flex items-end gap-0.5 h-24">
      {data.map((d, i) => {
        const pct = (d.active_workers / max) * 100;
        const full = d.active_workers >= maxWorkers;
        return (
          <div
            key={i}
            className={`flex-1 rounded-t ${full ? "bg-amber-500" : "bg-blue-500"} opacity-70`}
            style={{ height: `${pct}%`, minHeight: d.active_workers > 0 ? "4px" : "0" }}
            title={`${d.bucket}: ${d.active_workers} workers`}
          />
        );
      })}
    </div>
  );
}
