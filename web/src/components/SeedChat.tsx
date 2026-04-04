import { useState, type RefObject } from "react";
import type { Seed, SeedMessage, SeedBranchInfo } from "../hooks/useSeed";
import { TypingIndicator } from "./ActivityIndicator";
import { HtmlFragment } from "./FormattedContent";
import "./SeedFrame.css";

interface Props {
  seed: Seed | null;
  messages: SeedMessage[];
  isActive: boolean;
  isSeeded: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  taskId?: string;
  taskTitle?: string;
  streamingText?: string;
  stage?: string | null;
  branches?: SeedBranchInfo[];
  activeBranch?: string;
  wsSend?: (data: any) => void;
  onSend: (text: string) => void;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
}

export default function SeedChat({ seed, messages, isActive, isSeeded, containerRef, taskId, taskTitle, streamingText, stage, branches, activeBranch, wsSend, onSend, onStart, onStop, onDiscard }: Props) {
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  // State 1: No seed
  if (!seed) {
    return (
      <button
        onClick={onStart}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
      >
        🌱 Plant a Seed
      </button>
    );
  }

  // State 3: Completed seed
  if (isSeeded && !isActive) {
    return (
      <div className="border border-emerald-500/20 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs bg-emerald-500/5 hover:bg-emerald-500/10 transition-colors"
        >
          <span className="flex items-center gap-1.5 text-emerald-400">
            🌱 Seed {seed.summary ? `- ${seed.summary}` : "Complete"}
          </span>
          <span className="text-zinc-500">{expanded ? "\u25B2" : "\u25BC"}</span>
        </button>
        {expanded && (
          <div className="p-3 space-y-3 border-t border-emerald-500/20">
            {seed.spec && (
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-64 overflow-y-auto text-xs text-zinc-400 whitespace-pre-wrap">
                {seed.spec}
              </div>
            )}
            <button
              onClick={() => { onDiscard(); onStart(); }}
              className="px-3 py-1.5 rounded text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              Re-seed
            </button>
          </div>
        )}
      </div>
    );
  }

  // Determine if AI is "thinking" — active session with either no messages or last message from user
  const aiThinking = isActive && (messages.length === 0 || messages[messages.length - 1]?.source === "user");

  // State 2: Active session
  return (
    <div className="border border-emerald-500/30 rounded-lg overflow-hidden">
      {/* Header with task context */}
      <div className="flex items-center justify-between px-3 py-2 bg-emerald-500/5 border-b border-emerald-500/20">
        <span className="text-xs text-emerald-400 flex items-center gap-1.5 min-w-0">
          🌱 Seeding
          {taskId && <span className="text-zinc-500 font-mono">{taskId}</span>}
          {taskTitle && <span className="text-zinc-400 truncate">&mdash; {taskTitle}</span>}
        </span>
        <button
          onClick={onStop}
          className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors flex-shrink-0 ml-2"
        >
          ✕
        </button>
      </div>

      {/* Branch selector */}
      {(branches ?? []).length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-zinc-800 bg-zinc-900/50">
          <select
            value={activeBranch ?? "main"}
            onChange={e => wsSend?.({ type: "seed_switch_branch", taskId, branchId: e.target.value })}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-zinc-300 focus:outline-none"
          >
            <option value="main">Main</option>
            {(branches ?? []).map(b => (
              <option key={b.id} value={b.id}>{b.label ?? b.id}</option>
            ))}
          </select>
        </div>
      )}

      {/* Stage indicator */}
      {isActive && stage && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 text-[10px] text-zinc-400">
          <span className={`w-1.5 h-1.5 rounded-full ${
            stage === "exploring" ? "bg-blue-400" :
            stage === "clarifying" ? "bg-amber-400" :
            stage === "proposing" ? "bg-purple-400" :
            "bg-emerald-400"
          }`} />
          <span className="capitalize">{stage}</span>
        </div>
      )}

      {/* Messages */}
      <div ref={containerRef} className="max-h-80 overflow-y-auto p-3 space-y-2">
        {/* Welcome guidance when no messages yet */}
        {messages.length === 0 && (
          <div className="text-center py-4 space-y-2">
            <div className="text-xs text-zinc-400">
              Claude is reading the codebase and preparing a brainstorming session.
            </div>
            <div className="text-xs text-zinc-500">
              It will ask you questions one at a time to understand your goals, then propose a design.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`group flex ${msg.source === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
              msg.source === "user"
                ? "bg-zinc-800 text-zinc-300"
                : "bg-emerald-500/10 text-zinc-300"
            }`}>
              {msg.html ? (
                <HtmlFragment html={msg.html} onChoice={onSend} />
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
            {msg.source === "ai" && isActive && wsSend && (
              <button
                onClick={() => wsSend({ type: "seed_branch", taskId, parentMessageIndex: i, label: `Branch ${(branches ?? []).length + 1}` })}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-zinc-500 hover:text-blue-400 ml-2 self-center transition-opacity"
                title="Explore alternative direction"
              >
                Fork
              </button>
            )}
          </div>
        ))}
        {/* Streaming text while AI is generating */}
        {streamingText ? (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 bg-emerald-500/10 text-xs text-zinc-300 whitespace-pre-wrap">
              {streamingText}
              <span className="inline-block w-1.5 h-4 bg-zinc-400 ml-0.5 animate-pulse" />
            </div>
          </div>
        ) : aiThinking ? (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 bg-emerald-500/10">
              <TypingIndicator />
            </div>
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 p-2 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Reply to seed..."
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/40"
        />
        <button
          onClick={submit}
          className="px-3 py-1.5 rounded text-xs bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
