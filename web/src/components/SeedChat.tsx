import { useState, useCallback, type RefObject } from "react";
import DOMPurify from "dompurify";
import type { Seed, SeedMessage } from "../hooks/useSeed";
import "./SeedFrame.css";

interface Props {
  seed: Seed | null;
  messages: SeedMessage[];
  isActive: boolean;
  isSeeded: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
  onSend: (text: string) => void;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
}

function HtmlFragment({ html, onChoice }: { html: string; onChoice: (value: string) => void }) {
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["data-choice"] });

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest("[data-choice]");
      if (target) {
        const value = target.getAttribute("data-choice");
        if (value) {
          target.classList.add("selected");
          onChoice(`Selected: ${value}`);
        }
      }
    },
    [onChoice],
  );

  return (
    <div
      className="seed-html-frame"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

export default function SeedChat({ seed, messages, isActive, isSeeded, bottomRef, onSend, onStart, onStop, onDiscard }: Props) {
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

  // State 2: Active session
  return (
    <div className="border border-emerald-500/30 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-emerald-500/5 border-b border-emerald-500/20">
        <span className="text-xs text-emerald-400 flex items-center gap-1.5">
          🌱 Seeding...
        </span>
        <button
          onClick={onStop}
          className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div className="max-h-80 overflow-y-auto p-3 space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.source === "user" ? "justify-end" : "justify-start"}`}>
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
          </div>
        ))}
        <div ref={bottomRef} />
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
