import { useState, useEffect } from "react";

interface Props {
  /** Timestamp (ms or ISO string) to count elapsed time from */
  since?: number | string | null;
  /** Label shown before the elapsed time (default: "Working") */
  label?: string;
  /** Size variant */
  size?: "sm" | "md";
}

/**
 * Animated spinner with live elapsed-time counter.
 * Pure CSS animation — no dependencies.
 */
export default function ActivityIndicator({ since, label = "Working", size = "sm" }: Props) {
  const [elapsed, setElapsed] = useState(() => computeElapsed(since));

  useEffect(() => {
    setElapsed(computeElapsed(since));
    const id = setInterval(() => setElapsed(computeElapsed(since)), 1000);
    return () => clearInterval(id);
  }, [since]);

  const spinnerSize = size === "sm" ? "w-3 h-3" : "w-4 h-4";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`${spinnerSize} rounded-full border-2 border-current border-t-transparent animate-spin opacity-70`}
      />
      <span>
        {label}...{" "}
        {elapsed !== null && (
          <span className="tabular-nums">{formatElapsed(elapsed)}</span>
        )}
      </span>
    </span>
  );
}

/** Compact typing indicator — three animated dots */
export function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-0.5 text-zinc-500">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-current"
          style={{
            animation: "typing-bounce 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes typing-bounce {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
      `}</style>
    </span>
  );
}

function computeElapsed(since?: number | string | null): number | null {
  if (!since) return null;
  const ts = typeof since === "string" ? new Date(since).getTime() : since;
  if (isNaN(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
