import { useState } from "react";
import { api } from "../api/client";
import type { Task } from "../hooks/useTasks";

interface Props {
  task: Task;
  onAction: () => void;
}

export default function VerdictPanel({ task, onAction }: Props) {
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: string) => {
    setActing(true);
    setError(null);
    try {
      const body: Record<string, string> = { action };
      if (comment.trim()) body.comment = comment;
      await api(`/api/tasks/${task.id}/verdict`, { method: "POST", body: JSON.stringify(body) });
      onAction();
    } catch (err: any) {
      setError(err.message ?? "Action failed");
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* PR metadata */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
        {task.source_pr && <span>PR #{task.source_pr}</span>}
        {task.branch && <span className="font-mono text-zinc-500">{task.branch}</span>}
      </div>

      {/* Review report from session_summary */}
      {task.session_summary && (
        <div className="bg-zinc-800/50 rounded-lg p-3 text-xs text-zinc-300 whitespace-pre-wrap max-h-80 overflow-y-auto">
          {task.session_summary}
        </div>
      )}

      {/* Comment editor */}
      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment to post on the PR..."
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 min-h-[80px]"
        />
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => act("merge")}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
        >
          Merge
        </button>
        <button
          onClick={() => { setShowComment(true); act("request_changes"); }}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
        >
          Request Changes
        </button>
        <button
          onClick={() => { setShowComment(true); act("close"); }}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
        >
          Close
        </button>
        <button
          onClick={() => act("defer")}
          disabled={acting}
          className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-700 text-zinc-400 hover:bg-zinc-600 disabled:opacity-50"
        >
          Defer
        </button>
        {!showComment && (
          <button
            onClick={() => setShowComment(true)}
            className="px-3 py-1.5 rounded text-xs text-zinc-500 hover:text-zinc-300"
          >
            + Comment
          </button>
        )}
      </div>
    </div>
  );
}
