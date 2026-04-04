import { useState, type RefObject } from "react";
import type { ChatMessage } from "../hooks/useChat";
import { TypingIndicator } from "./ActivityIndicator";
import { FormattedContent } from "./FormattedContent";
import { api } from "../api/client";

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onReset?: () => void;
  bottomRef: RefObject<HTMLDivElement | null>;
  connected: boolean;
  thinking?: boolean;
}

export default function Chat({ messages, onSend, onReset, bottomRef, connected, thinking }: Props) {
  const [input, setInput] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetFlash, setResetFlash] = useState<"ok" | "err" | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input);
    setInput("");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest">
          Orchestrator
        </div>
        <button
          onClick={async () => {
            if (resetting) return;
            setResetting(true);
            setResetFlash(null);
            try {
              await api("/api/orchestrator/reset", { method: "POST" });
              onReset?.();
              setResetFlash("ok");
            } catch {
              setResetFlash("err");
            } finally {
              setResetting(false);
              setTimeout(() => setResetFlash(null), 2000);
            }
          }}
          disabled={resetting}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            resetFlash === "ok"
              ? "text-emerald-400 border-emerald-500/50"
              : resetFlash === "err"
              ? "text-red-400 border-red-500/50"
              : "text-zinc-500 hover:text-zinc-300 border-zinc-700 hover:border-zinc-600"
          } ${resetting ? "opacity-50 cursor-wait" : ""}`}
          title="Start a fresh orchestrator session"
        >
          {resetting ? "Resetting…" : resetFlash === "ok" ? "Session Reset ✓" : resetFlash === "err" ? "Reset Failed" : "New Session"}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        {messages.length === 0 && (
          <div className="text-zinc-600 text-center text-xs mt-8">
            Send a message to start a conversation with the orchestrator.
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id + msg.created_at} className={`${messageAlignment(msg.source)}`}>
            <div className={`inline-block max-w-[90%] px-3 py-2 rounded-lg text-sm ${messageStyle(msg.source)}`}>
              <FormattedContent text={msg.content} />
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5 px-1">
              {formatTime(msg.created_at)}
            </div>
          </div>
        ))}

        {thinking && (
          <div className="text-left">
            <div className="inline-block px-3 py-2 rounded-lg bg-emerald-500/10 rounded-tl-sm">
              <TypingIndicator />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-zinc-800">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-resize: reset then grow to content
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={connected ? "Message the orchestrator... (Shift+Enter for newline)" : "Connecting..."}
            disabled={!connected}
            rows={3}
            className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm
                       text-zinc-100 placeholder-zinc-500 resize-none
                       focus:outline-none focus:border-emerald-500/50
                       disabled:opacity-50"
            style={{ minHeight: "76px", maxHeight: "200px" }}
          />
          <button
            type="submit"
            disabled={!connected || !input.trim()}
            className="bg-emerald-500 text-zinc-950 font-bold px-4 py-2 rounded-lg text-sm
                       hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500
                       transition-colors flex-shrink-0"
            style={{ height: "38px" }}
          >
            &rarr;
          </button>
        </div>
      </form>
    </div>
  );
}


function messageAlignment(source: string): string {
  if (source === "user") return "text-right";
  if (source === "system") return "text-center";
  return "text-left";
}

function messageStyle(source: string): string {
  switch (source) {
    case "user":
      return "bg-zinc-700/50 text-zinc-200 rounded-tr-sm";
    case "orchestrator":
      return "bg-emerald-500/10 text-zinc-200 rounded-tl-sm";
    case "system":
      return "bg-zinc-800/50 text-zinc-500 text-xs";
    default:
      return "bg-zinc-800 text-zinc-300";
  }
}

function formatTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
