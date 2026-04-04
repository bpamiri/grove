# Task: W-075
## DAG wave visualization — show execution waves in task list and DAG editor

### Description
## Problem
The DAG editor (`DagEditor.tsx`) positions nodes on a simple grid (`i % 4` columns, `i / 4` rows). There's no visual grouping by execution wave, so users can't see which tasks will run in parallel vs. which are blocked.

## Scope
### 1. Wave-aware layout in DagEditor
- After loading DAG data from `/api/tasks/dag`, compute execution waves client-side using the same algorithm as `grove batch` (topological sort → group by depth level).
- Position nodes in columns by wave: Wave 1 tasks in the leftmost column, Wave 2 in the next, etc.
- Add wave labels ("Wave 1", "Wave 2") as non-interactive group headers or lane dividers.
- Color-code or badge nodes by wave assignment.

### 2. Wave badges in TaskList
- In the task list sidebar, show a small wave badge (e.g., `W1`, `W2`) next to each draft task that's part of a computed batch plan.
- This lets users see wave assignments without opening the DAG editor.

### 3. Wave summary in Dashboard
- Add a "Batch Plan" section to the Dashboard showing: total waves, tasks per wave, estimated parallelism.

## Key Files
- `web/src/components/DagEditor.tsx` — node positioning logic (line 46-61), currently grid-based
- `web/src/components/TaskList.tsx` — task list rendering
- `web/src/components/Dashboard.tsx` — dashboard panels
- `src/batch/dag.ts` — `topoSort`, `readyTasks` algorithms (reuse client-side or expose via API)

## Technical Notes
- The wave computation is lightweight (Kahn's algorithm) — fine to run client-side in the browser.
- ReactFlow supports group nodes and sub-flows which could be used for wave lanes.
- Consider adding a `GET /api/batch/plan?tree=grove` endpoint that returns the wave plan without dispatching, so the UI doesn't need to re-implement the heuristic file-overlap analysis.

### Workflow
This task follows the **development** path.

### Strategy
You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.

### Step Instructions
Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.

### Git Branch
Work on branch: `grove/W-075-dag-wave-visualization-show-execution-wa`
Commit message format: conventional commits — `feat: (W-075) description`, `fix: (W-075) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Reviewer Feedback
The adversarial reviewer rejected your previous plan for the following reasons. Revise your plan to address each point:

WRONG PLAN: The 'plan under review' is a W-072 session summary about markdown pipe-table rendering in Chat.tsx. It has nothing to do with W-075 (DAG wave visualization). None of the three scope items — (1) wave-aware DagEditor layout, (2) wave badges in TaskList, (3) wave summary in Dashboard — are addressed. The plan concludes 'feature is complete, ready for merge' referring to an entirely different feature.

To pass review, W-075 needs an actual implementation plan covering:
1. How wave data flows to DagEditor (reuse existing POST /api/batch/analyze or add a lighter GET endpoint)
2. Node positioning strategy — Dagre/ELK layout vs manual column assignment by wave index
3. How to integrate wave badges into TaskList without requiring a full batch analyze call on every render
4. Dashboard 'Batch Plan' section design — what data to show, where it fits among existing tabs
5. Whether to reuse the existing BatchPlan.tsx component or build new wave-specific components

Note: the codebase already has significant wave infrastructure (deriveWaves in analyze.ts, BatchPlan.tsx, /api/batch/analyze endpoint) that a proper plan should build on rather than duplicate.

### Checkpoint — Resuming from prior session
- **Step:** merge (index 3)
- **Last commit:** 64436fe62434adb6253d06ec182c0ccd608c6e88
- **Files modified:** .claude/CLAUDE.md, .grove/session-summary.md
- **Summary:** # Session Summary: W-075

## Summary

Implemented DAG wave visualization across three UI surfaces. Added a new `GET /api/batch/plan` endpoint that returns wave assignments without side effects, then built wave-aware layouts in the DagEditor, wave badges in the TaskList, and a new "Batch" tab in the Dashboard.

### Key Design Decisions

- **New GET /api/batch/plan endpoint** — idempotent endpoint returning `{ treeId, waves, taskWaves }` where `taskWaves` is a `Record<taskId, waveNumber>` for easy client-side consumption. Reuses existing `analyzeBatch` from `analyze.ts`.
- **Column-based wave layout** in DagEditor — nodes positioned by wave column (Wave 1 leftmost, Wave 2 next, etc.) with color-coded borders from an 8-color palette. Falls back to the original grid layout when no wave data is available.
- **Wave badges fetched at list level** — TaskList fetches the wave plan once when a tree has 2+ drafts, then renders `W1`/`W2` badges on individual cards. No per-card API calls.
- **Dashboard "Batch" tab** — standalone tab with KPI cards (total waves, max parallelism, avg tasks/wave), execution wave breakdown bars, and a tasks-per-wave bar chart. Includes a tree selector dropdown.
- **DAG treeId filter** — `GET /api/tasks/dag` now accepts optional `treeId` query parameter, filtering both nodes and edges to that tree.

## Files Modified

- `src/broker/server.ts` — new `GET /api/batch/plan` endpoint; `GET /api/tasks/dag` treeId filter
- `web/src/components/DagEditor.tsx` — wave-aware column layout, color-coded nodes, wave lane labels, legend overlay
- `web/src/components/TaskList.tsx` — wave plan fetch, `W1`/`W2` badges on draft task cards
- `web/src/components/Dashboard.tsx` — new `BatchTab` component with KPI cards, wave breakdown, parallelism chart
- `web/src/hooks/useAnalytics.ts` — added `"batch"` to `DashboardTab` union type
- `web/src/App.tsx` — pass `treeId` to DagEditor, pass `trees`/`selectedTree` to Dashboard

## Next Steps

- None — all three scope items implemented, build passes, 656 tests pass.

- **Cost so far:** $0.00

Continue from where you left off. The WIP commit contains your in-progress work.
Do NOT repeat work that's already committed.

### Previous Session
# Session Summary: W-075

## Summary

Implemented DAG wave visualization across three UI surfaces. Added a new `GET /api/batch/plan` endpoint that returns wave assignments without side effects, then built wave-aware layouts in the DagEditor, wave badges in the TaskList, and a new "Batch" tab in the Dashboard.

### Key Design Decisions

- **New GET /api/batch/plan endpoint** — idempotent endpoint returning `{ treeId, waves, taskWaves }` where `taskWaves` is a `Record<taskId, waveNumber>` for easy client-side consumption. Reuses existing `analyzeBatch` from `analyze.ts`.
- **Column-based wave layout** in DagEditor — nodes positioned by wave column (Wave 1 leftmost, Wave 2 next, etc.) with color-coded borders from an 8-color palette. Falls back to the original grid layout when no wave data is available.
- **Wave badges fetched at list level** — TaskList fetches the wave plan once when a tree has 2+ drafts, then renders `W1`/`W2` badges on individual cards. No per-card API calls.
- **Dashboard "Batch" tab** — standalone tab with KPI cards (total waves, max parallelism, avg tasks/wave), execution wave breakdown bars, and a tasks-per-wave bar chart. Includes a tree selector dropdown.
- **DAG treeId filter** — `GET /api/tasks/dag` now accepts optional `treeId` query parameter, filtering both nodes and edges to that tree.

## Files Modified

- `src/broker/server.ts` — new `GET /api/batch/plan` endpoint; `GET /api/tasks/dag` treeId filter
- `web/src/components/DagEditor.tsx` — wave-aware column layout, color-coded nodes, wave lane labels, legend overlay
- `web/src/components/TaskList.tsx` — wave plan fetch, `W1`/`W2` badges on draft task cards
- `web/src/components/Dashboard.tsx` — new `BatchTab` component with KPI cards, wave breakdown, parallelism chart
- `web/src/hooks/useAnalytics.ts` — added `"batch"` to `DashboardTab` union type
- `web/src/App.tsx` — pass `treeId` to DagEditor, pass `trees`/`selectedTree` to Dashboard

## Next Steps

- None — all three scope items implemented, build passes, 656 tests pass.


### Files Already Modified
.claude/CLAUDE.md
.grove/session-summary.md
src/broker/server.ts
web/src/App.tsx
web/src/components/DagEditor.tsx
web/src/components/Dashboard.tsx
web/src/components/TaskList.tsx
web/src/hooks/useAnalytics.ts

### Session Summary Instructions
Before finishing, create `.grove/session-summary.md` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains (if anything)

### Working Guidelines
- Make atomic commits: `feat: (W-075) description`, `fix: (W-075) description`
- Run tests if available before marking done
- Write the session summary file before finishing
