# Task: W-072
## Render markdown tables properly in orchestrator chat panel

### Description
## Problem
The `FormattedContent` component in `Chat.tsx` (line 148) detects markdown pipe tables (`|...|` lines) and renders them inside a `<pre>` block with monospace styling. This preserves alignment but doesn't render them as actual HTML tables with proper column structure, borders, and styling.

## Current Behavior
- Box-drawing tables (┌─┐) → monospace `<pre>` ✓
- Markdown pipe tables (`| col | col |`) → also monospace `<pre>` (looks OK but not great)
- No column alignment, no header styling, no zebra striping

## Scope
1. **Parse markdown tables** — detect header row, separator row (`|---|---|`), and data rows. Convert to structured data.
2. **Render as HTML `<table>`** — with proper `<thead>`, `<tbody>`, column alignment (from separator row `:---:` etc.).
3. **Style consistently** — dark theme table styling matching the Grove design system (zinc/emerald palette, subtle borders, header emphasis).
4. **Keep box-drawing fallback** — box-drawing character tables should still render as `<pre>` monospace.

## Key Files
- `web/src/components/Chat.tsx` — `FormattedContent` function (line 148), `BOX_CHARS` and `MD_TABLE` regexes (lines 137-139)

## Notes
- Consider using a lightweight markdown table parser rather than writing one from scratch. The rest of the markdown rendering is already custom (bold, code), so a full markdown library is probably overkill — just add table parsing.

### Workflow
This task follows the **development** path.

### Strategy
You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.

### Step Instructions
Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.

### Git Branch
Work on branch: `grove/W-072-render-markdown-tables-properly-in-orche`
Commit message format: conventional commits — `feat: (W-072) description`, `fix: (W-072) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Previous Session
# Session Summary: W-072

## Summary

Resumed and verified the completed markdown table rendering feature. The previous session implemented proper HTML `<table>` rendering for markdown pipe tables in the `FormattedContent` component (`web/src/components/Chat.tsx`). This session confirmed the build passes cleanly (`tsc -b && vite build`) and the implementation is solid.

### Key Design Decisions (from previous session)

- **Three block types**: `"text" | "box-table" | "md-table"` — first pass groups table-like lines, classification step separates box-drawing from valid markdown tables.
- **No external dependencies**: Table parsing is self-contained (~50 lines).
- **Graceful fallback**: Invalid pipe-table blocks fall back to `<pre>` rendering.
- **Alignment support**: Parses GFM separator syntax (`:---`, `:---:`, `---:`) and applies via `textAlign` style.
- **Inline formatting preserved**: Table cells pass through `InlineFormat` for `**bold**` and `` `code` `` rendering.

## Files Modified

- `web/src/components/Chat.tsx` — refactored `FormattedContent` block detection, added `parseMdTable` parser, `MarkdownTable` component, and supporting types/helpers

## Next Steps

- None — feature is complete. Build verified. Ready for merge.


### Files Already Modified
package.json
src/shared/types.ts
web/src/components/Chat.tsx
web/src/components/Sidebar.tsx

### Session Summary Instructions
Before finishing, create `.grove/session-summary.md` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains (if anything)

### Working Guidelines
- Make atomic commits: `feat: (W-072) description`, `fix: (W-072) description`
- Run tests if available before marking done
- Write the session summary file before finishing
