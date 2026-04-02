# Session Summary: W-054

## Summary

Implemented cross-task pattern detection for Grove (issue #127). Added five new analytics queries, a REST endpoint, a CLI command, and an Insights dashboard tab that surfaces systemic failure patterns — most-failing gates with top error messages, retry rates by pipeline path, tree success rates, success rate trends over time, and common failure reasons.

## Changes Made

### Backend — DB Queries (`src/broker/db.ts`)
- `insightsFailingGates(since)` — gates ranked by failure count with most common error message per gate (correlated subquery)
- `insightsRetriesByPath(since)` — retry counts grouped by pipeline path name
- `insightsTreeFailureRates(since)` — success/failure breakdown per tree
- `insightsSuccessTrend(since)` — daily success rate trend
- `insightsCommonFailures(since, limit)` — top gate/message failure combos
- All queries filter `status IN ('completed', 'failed')` for consistency

### Backend — API Endpoint (`src/broker/server.ts`)
- `GET /api/analytics/insights?range=1h|4h|24h|7d` — returns all five insight datasets
- Defaults to `7d` range (wider window suits pattern detection)

### CLI Command (`src/cli/commands/insights.ts`)
- `grove insights [range]` — formatted terminal output with color-coded bars
- Range validation against valid values (1h, 4h, 24h, 7d)
- Registered in CLI router and help output

### Frontend — Data Layer (`web/src/hooks/useAnalytics.ts`)
- Added `InsightsData` and sub-types (`FailingGate`, `RetriesByPath`, `TreeFailureRate`, `SuccessTrendDay`, `CommonFailure`)
- Added `"insights"` to `DashboardTab` union
- Added insights fetch branch and state in `useAnalytics` hook

### Frontend — Dashboard (`web/src/components/Dashboard.tsx`)
- "Insights" tab in TabStrip
- `InsightsTab` component with:
  - KPI summary (success rate, total failures, top failing gate, tasks retried)
  - Most-failing gates panel with failure bars and top error messages
  - Common failure reasons list
  - Retries by path with retry percentage bars
  - Tree success rates with color-coded bars (green/amber/red)
  - Success rate trend chart (stacked completed/failed bars per day)

### Tests (`tests/broker/db-insights.test.ts`)
- 12 tests covering all 5 query methods
- Tests use evaluator's actual array format for gate_results
- Edge cases: empty data, passing-only gates, non-terminal task exclusion

## Files Modified
- `src/broker/db.ts` — 5 new insight query methods
- `src/broker/server.ts` — insights endpoint
- `src/cli/commands/insights.ts` — new file, CLI command
- `src/cli/index.ts` — command registration + help
- `web/src/hooks/useAnalytics.ts` — types, state, fetch logic
- `web/src/components/Dashboard.tsx` — InsightsTab + sub-components
- `tests/broker/db-insights.test.ts` — new file, 12 tests

## Next Steps
- None — feature is complete as specified in issue #127
