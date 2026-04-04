import { useCallback } from "react";
import DOMPurify from "dompurify";

// Box-drawing characters used in Claude Code TUI tables
const BOX_CHARS = /[┌┐└┘├┤┬┴┼│─]/;
// Markdown pipe tables: lines starting with | and containing at least one more |
const MD_TABLE = /^\s*\|.*\|/;

/**
 * Render message content with basic formatting:
 * - Box-drawing table blocks → monospace <pre>
 * - **bold** → <strong>
 * - `code` → <code>
 * - Newlines preserved
 */
export function FormattedContent({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: { type: "text" | "table"; lines: string[] }[] = [];
  let current: { type: "text" | "table"; lines: string[] } = { type: "text", lines: [] };

  for (const line of lines) {
    const isTable = BOX_CHARS.test(line) || MD_TABLE.test(line);
    if (isTable && current.type !== "table") {
      if (current.lines.length) blocks.push(current);
      current = { type: "table", lines: [line] };
    } else if (!isTable && current.type === "table") {
      blocks.push(current);
      current = { type: "text", lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) blocks.push(current);

  return (
    <>
      {blocks.map((block, i) =>
        block.type === "table" ? (
          <pre
            key={i}
            className="my-1 text-[11px] leading-tight overflow-x-auto text-zinc-300 font-mono"
          >
            {block.lines.join("\n")}
          </pre>
        ) : (
          <span key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <InlineFormat text={line} />
              </span>
            ))}
          </span>
        )
      )}
    </>
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
