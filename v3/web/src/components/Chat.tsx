import { useState, type RefObject } from "react";
import type { ChatMessage } from "../hooks/useChat";

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  bottomRef: RefObject<HTMLDivElement | null>;
  connected: boolean;
}

export default function Chat({ messages, onSend, bottomRef, connected }: Props) {
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input);
    setInput("");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800">
        <div className="text-emerald-400 font-bold text-xs uppercase tracking-widest">
          Orchestrator
        </div>
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
              {msg.content}
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5 px-1">
              {formatTime(msg.created_at)}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-zinc-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={connected ? "Message the orchestrator..." : "Connecting..."}
            disabled={!connected}
            className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm
                       text-zinc-100 placeholder-zinc-500
                       focus:outline-none focus:border-emerald-500/50
                       disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!connected || !input.trim()}
            className="bg-emerald-500 text-zinc-950 font-bold px-4 py-2 rounded-lg text-sm
                       hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500
                       transition-colors"
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
