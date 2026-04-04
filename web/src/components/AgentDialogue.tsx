import { useState, useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { TypingIndicator } from "./ActivityIndicator";

export interface DialogueMessage {
  source: string;
  content: string;
  html?: string;
  created_at?: string;
}

interface Props {
  messages: DialogueMessage[];
  onSend: (text: string) => void;
  header: ReactNode;
  renderMessage: (msg: DialogueMessage, index: number) => ReactNode;

  placeholder?: string;
  disabled?: boolean;
  inputVariant?: "textarea" | "inline";
  submitLabel?: ReactNode;

  thinking?: boolean;
  streamingText?: string;

  /** When set, the input draft is persisted to sessionStorage under this key. */
  draftKey?: string;
  /** When set, scroll position is saved to sessionStorage on beforeunload and restored on mount. */
  scrollKey?: string;

  bottomRef?: RefObject<HTMLDivElement | null>;
  containerRef?: RefObject<HTMLDivElement | null>;

  emptyState?: ReactNode;
  className?: string;
  messageListClassName?: string;
}

export default function AgentDialogue({
  messages,
  onSend,
  header,
  renderMessage,
  placeholder = "Type a message...",
  disabled = false,
  inputVariant = "textarea",
  submitLabel,
  thinking = false,
  streamingText,
  draftKey,
  scrollKey,
  bottomRef,
  containerRef,
  emptyState,
  className = "flex flex-col h-full",
  messageListClassName = "flex-1 overflow-y-auto p-3 space-y-3 text-sm",
}: Props) {
  // Persist draft to sessionStorage when a draftKey is provided
  const [persisted, setPersisted] = usePersistedState(draftKey ?? "", "", sessionStorage);
  const [ephemeral, setEphemeral] = useState("");
  const input = draftKey ? persisted : ephemeral;
  const setInput = draftKey ? setPersisted : setEphemeral;

  // Internal ref for scroll container — merged with external containerRef
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (containerRef) (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [containerRef]);

  // Save scroll position on beforeunload, restore on mount
  useEffect(() => {
    if (!scrollKey) return;
    const el = scrollRef.current;

    // Restore saved position once messages are loaded
    if (el && messages.length > 0) {
      try {
        const saved = sessionStorage.getItem(scrollKey);
        if (saved !== null) {
          el.scrollTop = Number(saved);
          sessionStorage.removeItem(scrollKey);
        }
      } catch { /* noop */ }
    }
  }, [scrollKey, messages.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!scrollKey) return;
    const handler = () => {
      const el = scrollRef.current;
      if (el) {
        try { sessionStorage.setItem(scrollKey, String(el.scrollTop)); } catch { /* noop */ }
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [scrollKey]);

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim()) return;
    onSend(input);
    setInput("");
    if (draftKey) {
      try { sessionStorage.removeItem(draftKey); } catch { /* noop */ }
    }
  }, [input, onSend, setInput, draftKey]);

  return (
    <div className={className}>
      {header}

      <div ref={setScrollRef} className={messageListClassName}>
        {messages.length === 0 && emptyState}

        {messages.map((msg, i) => renderMessage(msg, i))}

        {streamingText ? (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 bg-emerald-500/10 text-xs text-zinc-300 whitespace-pre-wrap">
              {streamingText}
              <span className="inline-block w-1.5 h-4 bg-zinc-400 ml-0.5 animate-pulse" />
            </div>
          </div>
        ) : thinking ? (
          <div className="text-left">
            <div className="inline-block px-3 py-2 rounded-lg bg-emerald-500/10">
              <TypingIndicator />
            </div>
          </div>
        ) : null}

        {bottomRef && <div ref={bottomRef} />}
      </div>

      {inputVariant === "textarea" ? (
        <form onSubmit={handleSubmit} className="p-3 border-t border-zinc-800">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={placeholder}
              disabled={disabled}
              rows={3}
              className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm
                         text-zinc-100 placeholder-zinc-500 resize-none
                         focus:outline-none focus:border-emerald-500/50
                         disabled:opacity-50"
              style={{ minHeight: "76px", maxHeight: "200px" }}
            />
            <button
              type="submit"
              disabled={disabled || !input.trim()}
              className="bg-emerald-500 text-zinc-950 font-bold px-4 py-2 rounded-lg text-sm
                         hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500
                         transition-colors flex-shrink-0"
              style={{ height: "38px" }}
            >
              {submitLabel ?? <>&rarr;</>}
            </button>
          </div>
        </form>
      ) : (
        <div className="border-t border-zinc-800 p-2 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={placeholder}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/40"
          />
          <button
            onClick={() => handleSubmit()}
            className="px-3 py-1.5 rounded text-xs bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            {submitLabel ?? "Send"}
          </button>
        </div>
      )}
    </div>
  );
}
