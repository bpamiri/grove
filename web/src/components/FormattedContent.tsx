import { useCallback } from "react";
import DOMPurify from "dompurify";

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

/** Classify a raw table block as box-drawing or markdown pipe table */
function classifyTableBlock(lines: string[]): { type: BlockType; lines: string[] } {
  const hasBoxChars = lines.some((l) => BOX_CHARS.test(l));
  if (hasBoxChars) return { type: "box-table", lines };
  if (parseMdTable(lines)) return { type: "md-table", lines };
  return { type: "box-table", lines };
}

/**
 * Render message content with basic formatting:
 * - Box-drawing table blocks → monospace <pre>
 * - Markdown pipe tables → HTML <table>
 * - **bold** → <strong>
 * - `code` → <code>
 * - Newlines preserved
 */
export function FormattedContent({ text }: { text: string }) {
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
export function InlineFormat({ text }: { text: string }) {
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

/**
 * Render sanitized HTML with click handling for data-choice elements.
 * Uses DOMPurify to sanitize HTML content before rendering.
 */
export function HtmlFragment({ html, onChoice }: { html: string; onChoice: (value: string) => void }) {
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
