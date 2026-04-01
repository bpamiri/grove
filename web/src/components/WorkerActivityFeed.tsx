import { useEffect, useRef, useState } from "react";
import ActivityIndicator from "./ActivityIndicator";

export interface ActivityEntry {
  ts: number;
  msg: string;
  kind?: string;
}

interface Props {
  log: ActivityEntry[];
  taskStatus: string;
  paused?: boolean;
  since?: string | null;
  costUsd?: number;
}

/**
 * Live scrolling feed of SAP agent events (tool_use, thinking, text, cost).
 * Renders in three modes:
 *  - idle: task is draft/queued — shows "No worker active"
 *  - live: task is active — auto-scrolling feed with pause/resume
 *  - completed: task is completed/failed — collapsed summary, expandable
 */
export default function WorkerActivityFeed({ log, taskStatus, paused: taskPaused, since, costUsd }: Props) {
  const isLive = taskStatus === "active" && !taskPaused;
  const isIdle = taskStatus === "draft" || taskStatus === "queued" || taskStatus === "waiting" || taskStatus === "cancelled";
  const isComplete = taskStatus === "completed" || taskStatus === "failed";

  // Idle state
  if (isIdle) {
    return (
      <Section label="Activity">
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-center">
          <span className="text-zinc-500 text-xs">No worker active</span>
        </div>
      </Section>
    );
  }

  // Completed/failed — collapsed summary
  if (isComplete && log.length > 0) {
    return <CompletedSummary log={log} taskStatus={taskStatus} costUsd={costUsd} />;
  }

  // Live (or paused active task, or completed with no log)
  return <LiveFeed log={log} live={isLive} since={since} />;
}

// ---------------------------------------------------------------------------
// Live feed with auto-scroll and pause/resume
// ---------------------------------------------------------------------------

function LiveFeed({ log, live, since }: { log: ActivityEntry[]; live: boolean; since?: string | null }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [pinnedLength, setPinnedLength] = useState(0);

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [log.length, paused]);

  const displayLog = paused ? log.slice(0, pinnedLength) : log;

  return (
    <Section label={live ? "Live Activity" : "Activity Log"}>
      <div className="flex justify-end -mt-6 mb-1">
        {live && log.length > 0 && (
          <button
            onClick={() => {
              if (!paused) setPinnedLength(log.length);
              setPaused(!paused);
            }}
            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          >
            {paused ? `Resume (${log.length - pinnedLength} new)` : "Pause"}
          </button>
        )}
      </div>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {displayLog.length === 0 && live && (
          <div className="text-blue-400/70 text-center py-3">
            <ActivityIndicator since={since} label="Waiting for activity" size="md" />
          </div>
        )}
        {displayLog.map((entry, i) => (
          <FeedRow key={i} entry={entry} />
        ))}
        {displayLog.length > 0 && live && !paused && (
          <div className="text-blue-400/60 px-1 pt-1">
            <ActivityIndicator since={displayLog[displayLog.length - 1]?.ts} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Completed summary — collapsed by default, expandable
// ---------------------------------------------------------------------------

function CompletedSummary({ log, taskStatus, costUsd }: { log: ActivityEntry[]; taskStatus: string; costUsd?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lastEntries = log.slice(-3);
  const statusColor = taskStatus === "completed" ? "text-emerald-400" : "text-red-400";

  return (
    <Section label="Activity">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg">
        {/* Summary header — always visible */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-left px-3 py-2 flex justify-between items-center hover:bg-zinc-900/50 rounded-lg"
        >
          <div className="text-[11px] font-mono text-zinc-400 truncate flex-1">
            {lastEntries.map((e, i) => (
              <span key={i}>
                {i > 0 && <span className="text-zinc-600 mx-1">→</span>}
                <span className={activityColor(e.msg, e.kind)}>{truncate(e.msg, 40)}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            {costUsd != null && costUsd > 0 && (
              <span className="text-emerald-400 text-[10px]">${costUsd.toFixed(2)}</span>
            )}
            <span className={`text-[10px] ${statusColor}`}>
              {taskStatus} · {log.length} events
            </span>
            <span className="text-zinc-600 text-[10px]">{expanded ? "▲" : "▼"}</span>
          </div>
        </button>

        {/* Expanded full log */}
        {expanded && (
          <div className="border-t border-zinc-800 p-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed">
            {log.map((entry, i) => (
              <FeedRow key={i} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function FeedRow({ entry }: { entry: ActivityEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="flex gap-2 hover:bg-zinc-900/50 px-1 rounded group">
      <span className="text-zinc-600 flex-shrink-0">{time}</span>
      <span className={`${activityColor(entry.msg, entry.kind)} break-all`}>
        {entry.msg.length > 200 ? (
          <TruncatedText text={entry.msg} maxLength={200} />
        ) : entry.msg}
      </span>
    </div>
  );
}

function TruncatedText({ text, maxLength }: { text: string; maxLength: number }) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <span>
        {text}{" "}
        <button onClick={() => setExpanded(false)} className="text-blue-400/60 hover:text-blue-400">less</button>
      </span>
    );
  }
  return (
    <span>
      {text.slice(0, maxLength)}
      <button onClick={() => setExpanded(true)} className="text-blue-400/60 hover:text-blue-400">...more</button>
    </span>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-zinc-500 text-xs uppercase mb-1.5">{label}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

export function activityColor(msg: string, kind?: string): string {
  if (kind === "thinking") return "text-purple-400/70 italic";
  if (kind === "text") return "text-zinc-300/80";
  if (kind === "cost") return "text-emerald-400";
  if (kind === "tool") {
    if (msg.startsWith("Read") || msg.startsWith("Grep") || msg.startsWith("Glob")) return "text-zinc-400";
    if (msg.startsWith("Edit") || msg.startsWith("Write")) return "text-amber-400";
    if (msg.startsWith("Bash")) return "text-cyan-400";
    return "text-blue-400";
  }
  // Legacy worker:activity messages (no kind)
  if (msg.startsWith("thinking:")) return "text-purple-400/70 italic";
  if (msg.startsWith("Read") || msg.startsWith("Grep") || msg.startsWith("Glob")) return "text-zinc-400";
  if (msg.startsWith("Edit") || msg.startsWith("Write")) return "text-amber-400";
  if (msg.startsWith("Bash")) return "text-cyan-400";
  if (!msg.includes(":") || msg.indexOf(":") > 20) return "text-zinc-300/80";
  return "text-zinc-300";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}
