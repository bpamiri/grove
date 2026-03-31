# Agent-Powered Batch File Prediction

**Issues:** #70, #86
**Date:** 2026-03-31

## Problem

The batch planner's heuristic file prediction (`extractFileHints()` in `src/batch/analyze.ts`) fails on natural language task descriptions. It only matches code identifiers (PascalCase, camelCase, kebab-case, file paths). Descriptions like "fix the sidebar appearance" or "improve user authentication flow" yield zero predicted files, making the overlap matrix useless.

The `mode: "agent"` parameter is already parsed in `POST /api/batch/analyze` but never implemented.

## Solution

Add `agentAnalyzeBatch(tasks, repoFiles)` — a single Claude Code subprocess call that predicts modified files for all tasks at once. Wire it into the existing `analyzeBatch()` function via the existing `mode` parameter. The rest of the pipeline (overlap matrix → wave derivation → dispatch) is unchanged.

## New Function: `agentAnalyzeBatch(tasks, repoFiles)`

Location: `src/batch/agent-analyze.ts` (new file — keeps agent logic separate from heuristic)

**Flow:**
1. Build a prompt with all task descriptions + truncated repo file list
2. Spawn `claude -p "<prompt>" --output-format stream-json --dangerously-skip-permissions`
3. Parse the stream-json output for the final assistant text message
4. Extract the JSON mapping: `{ "W-001": ["file1.ts", "file2.ts"], ... }`
5. Convert to `TaskAnalysis[]` with confidence "high" (agent-backed predictions)

**Prompt structure:**
```
You are analyzing a set of development tasks for a codebase. For each task, predict which files will likely be modified during implementation.

Here are the tasks:

1. W-001: "Fix sidebar navigation" — Description: The sidebar nav links don't highlight the current page...
2. W-002: "Add task filtering" — Description: Users need to filter tasks by status...
...

Here are the files in the repository:
src/components/Sidebar.tsx
src/components/TaskList.tsx
src/hooks/useTasks.ts
...

For each task, return a JSON object mapping task IDs to arrays of predicted file paths. Only include files from the repository list above. Return ONLY the JSON, no other text.

{
  "W-001": ["src/components/Sidebar.tsx", "src/styles/sidebar.css"],
  "W-002": ["src/components/TaskList.tsx", "src/hooks/useTasks.ts"]
}
```

**File list truncation:** If `repoFiles` exceeds 500 entries, truncate to the most relevant directories (src/, lib/, app/, web/src/) to stay within context limits.

**Error handling:** If the Claude process fails or returns unparseable output, fall back to heuristic analysis for all tasks. Log the error but don't fail the batch analysis.

**Cost:** ~$0.01-0.05 per batch call (depends on task count and repo size). The prompt is compact — task descriptions + file list.

## Updated `analyzeBatch()` Signature

```typescript
export async function analyzeBatch(
  tasks: Task[],
  repoPath: string,
  mode: "heuristic" | "agent" | "hybrid" = "heuristic",
): Promise<BatchPlan>
```

**Breaking change:** `analyzeBatch` becomes async (returns Promise). Callers in `server.ts` already use `await import()` so adding `await` is trivial.

**Mode behavior:**
- `"heuristic"` — current behavior, free, instant
- `"agent"` — all tasks through Claude, ~1-3 seconds
- `"hybrid"` — heuristic first, agent fallback for tasks with zero predicted files

## Layers Modified

| Layer | File | Changes |
|-------|------|---------|
| Agent | `src/batch/agent-analyze.ts` | New: `agentAnalyzeBatch()` |
| Core | `src/batch/analyze.ts` | Update `analyzeBatch()` to accept mode, call agent path |
| API | `src/broker/server.ts` | Pass `mode` param through to `analyzeBatch()` |
| CLI | `src/cli/commands/batch.ts` | Add `--agent` and `--hybrid` flags |
| Web | `web/src/components/BatchPlan.tsx` | Add mode toggle (Heuristic / AI-Assisted) |
| Types | `src/batch/types.ts` | Add `mode` field to `BatchPlan` response |

## CLI Changes

```bash
grove batch <tree>            # heuristic (default)
grove batch <tree> --agent    # all tasks through Claude
grove batch <tree> --hybrid   # heuristic + agent fallback for low-confidence
grove batch <tree> --run      # existing: auto-dispatch after analysis
```

Flags are combinable: `grove batch grove --hybrid --run`

## Web UI Changes

In `BatchPlan.tsx`, add a toggle next to the "Analyze Draft Tasks" button:

```
[Analyze Draft Tasks ▾]  ○ Fast  ● AI-Assisted
```

"Fast" = heuristic, "AI-Assisted" = hybrid mode. The toggle sets the `mode` param in the POST request.

## Tests

- **Unit:** `agentAnalyzeBatch` with mocked Claude output (valid JSON, invalid JSON, process failure)
- **Unit:** `analyzeBatch` mode routing (heuristic/agent/hybrid paths)
- **Integration:** Existing heuristic tests should continue to pass unchanged

## Out of Scope

- Priority-aware wave ordering
- Granular per-task dependencies (current wave-level deps are fine)
- User feedback loop for correcting predictions
- Caching agent results
