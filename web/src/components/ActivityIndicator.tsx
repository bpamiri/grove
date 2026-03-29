import { useState, useEffect } from "react";

/* ── Spinner ─────────────────────────────────────────────────── */

const spinnerKeyframes = `
@keyframes grove-spin {
  to { transform: rotate(360deg); }
}
`;

function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <>
      <style>{spinnerKeyframes}</style>
      <span
        className={`inline-block rounded-full border-2 border-current border-t-transparent ${className}`}
        style={{
          width: size,
          height: size,
          animation: "grove-spin 0.8s linear infinite",
        }}
        role="status"
        aria-label="Loading"
      />
    </>
  );
}

/* ── Elapsed timer ───────────────────────────────────────────── */

function ElapsedTime({ since }: { since: string }) {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return <span>{formatElapsed(since)}</span>;
}

function formatElapsed(dateStr: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/* ── Activity indicator (spinner + optional label + timer) ──── */

export function ActivityIndicator({
  label,
  since,
  className = "",
}: {
  label?: string;
  since?: string | null;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Spinner size={12} />
      {label && <span className="truncate">{label}</span>}
      {since && (
        <span className="text-zinc-500 shrink-0">
          <ElapsedTime since={since} />
        </span>
      )}
    </span>
  );
}

/* ── Typing indicator (bouncing dots for chat) ──────────────── */

const dotsKeyframes = `
@keyframes grove-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}
`;

export function TypingIndicator() {
  return (
    <div className="text-left">
      <style>{dotsKeyframes}</style>
      <span className="inline-flex items-center gap-1 bg-emerald-500/10 px-3 py-2 rounded-lg rounded-tl-sm">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-emerald-400/60"
            style={{ animation: `grove-bounce 1.2s ease-in-out ${i * 0.15}s infinite` }}
          />
        ))}
      </span>
    </div>
  );
}
