import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

interface EventEntry {
  id: number;
  task_id: string | null;
  event_type: string;
  summary: string | null;
  created_at: string;
}

export default function EventLogViewer() {
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [taskFilter, setTaskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [since, setSince] = useState("1h");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ since });
    if (taskFilter) params.set("task", taskFilter);
    if (typeFilter) params.set("type", typeFilter);
    try {
      const data = await api<EventEntry[]>(`/api/analytics/events?${params}`);
      setEvents(data);
    } catch {}
  }, [taskFilter, typeFilter, since]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex gap-2 mb-2 text-xs">
        <input
          value={taskFilter}
          onChange={e => setTaskFilter(e.target.value)}
          placeholder="Task ID"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-24 text-zinc-300 focus:outline-none"
        />
        <input
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          placeholder="Event type"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-32 text-zinc-300 focus:outline-none"
        />
        <select value={since} onChange={e => setSince(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300">
          <option value="1h">1h</option>
          <option value="4h">4h</option>
          <option value="24h">24h</option>
          <option value="7d">7d</option>
        </select>
        <button onClick={load} className="px-2 py-1 bg-zinc-700 rounded text-zinc-300 hover:bg-zinc-600">Refresh</button>
      </div>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg max-h-64 overflow-y-auto font-mono text-[11px]">
        {events.length === 0 ? (
          <div className="text-zinc-500 p-4 text-center">No events</div>
        ) : events.map(e => (
          <div key={e.id} className="flex gap-2 px-2 py-0.5 hover:bg-zinc-900/50 border-b border-zinc-800/50">
            <span className="text-zinc-600 flex-shrink-0">{new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="text-blue-400 flex-shrink-0 w-28 truncate">{e.event_type}</span>
            <span className="text-zinc-400 flex-shrink-0 w-14">{e.task_id ?? ""}</span>
            <span className="text-zinc-300 truncate">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
