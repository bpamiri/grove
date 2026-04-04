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
