import { useState, type RefObject } from "react";
import type { ChatMessage } from "../hooks/useChat";
import { TypingIndicator } from "./ActivityIndicator";
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

// Box-drawing characters used in Claude Code TUI tables
const BOX_CHARS = /[┌┐└┘├┤┬┴┼│─]/;
// Markdown pipe tables: lines starting with | and containing at least one more |
const MD_TABLE = /^\s*\|.*\|/;
// Separator row: | followed by dashes/colons pattern, e.g. |---|:---:|---:|
const MD_SEP = /^\s*\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|\s*$/;

type Align = "left" | "center" | "right";

interface ParsedTable {
  headers: string[];
  alignments: Align[];
  rows: string[][];
}

/** Split a pipe-delimited row into trimmed cells, ignoring leading/trailing pipes */
function splitCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/** Parse alignment from a separator cell like :---:, ---:, :---, or --- */
function parseAlign(cell: string): Align {
  const t = cell.trim();
  if (t.startsWith(":") && t.endsWith(":")) return "center";
  if (t.endsWith(":")) return "right";
  return "left";
}

/** Try to parse a block of pipe-table lines into structured table data */
function parseMdTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  // Second line must be the separator row
  if (!MD_SEP.test(lines[1])) return null;

  const headers = splitCells(lines[0]);
  const sepCells = splitCells(lines[1]);
  if (headers.length === 0 || sepCells.length !== headers.length) return null;

  const alignments = sepCells.map(parseAlign);
  const rows = lines.slice(2).map((line) => {
    const cells = splitCells(line);
    // Pad or trim to match header count
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });

  return { headers, alignments, rows };
}

type BlockType = "text" | "box-table" | "md-table";

/**
 * Render message content with basic formatting:
 * - Box-drawing table blocks → monospace <pre>
 * - Markdown pipe tables → HTML <table>
 * - **bold** → <strong>
 * - `code` → <code>
 * - Newlines preserved
 */
function FormattedContent({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: { type: BlockType; lines: string[] }[] = [];
  let current: { type: "text" | "table-raw"; lines: string[] } = { type: "text", lines: [] };

  // First pass: group lines into text vs table-raw (any table-like line)
  for (const line of lines) {
    const isTable = BOX_CHARS.test(line) || MD_TABLE.test(line);
    if (isTable && current.type !== "table-raw") {
      if (current.lines.length) blocks.push({ type: "text", lines: current.lines });
      current = { type: "table-raw", lines: [line] };
    } else if (!isTable && current.type === "table-raw") {
      // Classify the raw table block
      blocks.push(classifyTableBlock(current.lines));
      current = { type: "text", lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) {
    blocks.push(
      current.type === "table-raw"
        ? classifyTableBlock(current.lines)
        : { type: "text", lines: current.lines },
    );
  }

  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "box-table") {
          return (
            <pre
              key={i}
              className="my-1 text-[11px] leading-tight overflow-x-auto text-zinc-300 font-mono"
            >
              {block.lines.join("\n")}
            </pre>
          );
        }
        if (block.type === "md-table") {
          const parsed = parseMdTable(block.lines);
          if (parsed) return <MarkdownTable key={i} table={parsed} />;
          // Fallback to pre if parse fails
          return (
            <pre
              key={i}
              className="my-1 text-[11px] leading-tight overflow-x-auto text-zinc-300 font-mono"
            >
              {block.lines.join("\n")}
            </pre>
          );
        }
        return (
          <span key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <InlineFormat text={line} />
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** Classify a raw table block as box-drawing or markdown pipe table */
function classifyTableBlock(lines: string[]): { type: BlockType; lines: string[] } {
  const hasBoxChars = lines.some((l) => BOX_CHARS.test(l));
  if (hasBoxChars) return { type: "box-table", lines };
  // All lines are pipe-table lines — check if it's a valid markdown table
  if (parseMdTable(lines)) return { type: "md-table", lines };
  // Not a valid markdown table, fall back to box-table (pre) rendering
  return { type: "box-table", lines };
}

/** Render a parsed markdown table as an HTML table */
function MarkdownTable({ table }: { table: ParsedTable }) {
  return (
    <div className="my-1.5 overflow-x-auto rounded border border-zinc-700/60">
      <table className="w-full text-[11px] leading-relaxed border-collapse">
        <thead>
          <tr className="bg-zinc-800/80 border-b border-zinc-600/50">
            {table.headers.map((h, i) => (
              <th
                key={i}
                className="px-2.5 py-1.5 font-semibold text-emerald-300/90 whitespace-nowrap"
                style={{ textAlign: table.alignments[i] }}
              >
                <InlineFormat text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr
              key={ri}
              className={`border-b border-zinc-700/30 ${
                ri % 2 === 1 ? "bg-zinc-800/30" : ""
              } hover:bg-zinc-700/20 transition-colors`}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-2.5 py-1 text-zinc-300 whitespace-nowrap"
                  style={{ textAlign: table.alignments[ci] }}
                >
                  <InlineFormat text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render inline formatting: **bold**, `code` */
function InlineFormat({ text }: { text: string }) {
  // Split on **bold** and `code` patterns
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="bg-zinc-800 px-1 py-0.5 rounded text-emerald-300 text-xs font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
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
