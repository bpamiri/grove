import { useState, type RefObject } from "react";
import type { Seed, SeedMessage, SeedBranchInfo } from "../hooks/useSeed";
import type { DialogueMessage } from "./AgentDialogue";
import AgentDialogue from "./AgentDialogue";
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
  const [expanded, setExpanded] = useState(false);

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
    <AgentDialogue
      messages={messages}
      onSend={onSend}
      containerRef={containerRef}
      thinking={aiThinking}
      streamingText={streamingText}
      draftKey={taskId ? `grove-draft-seed-${taskId}` : undefined}
      scrollKey={taskId ? `grove-scroll-seed-${taskId}` : undefined}
      inputVariant="inline"
      placeholder="Reply to seed..."
      submitLabel="Send"
      className="border border-emerald-500/30 rounded-lg overflow-hidden"
      messageListClassName="max-h-80 overflow-y-auto p-3 space-y-2"
      header={
        <>
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
        </>
      }
      emptyState={
        <div className="text-center py-4 space-y-2">
          <div className="text-xs text-zinc-400">
            Claude is reading the codebase and preparing a brainstorming session.
          </div>
          <div className="text-xs text-zinc-500">
            It will ask you questions one at a time to understand your goals, then propose a design.
          </div>
        </div>
      }
      renderMessage={(msg: DialogueMessage, i: number) => (
        <div className={`group flex ${msg.source === "user" ? "justify-end" : "justify-start"}`}>
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
      )}
    />
  );
}
