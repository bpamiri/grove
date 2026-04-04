# Session Summary: W-068

## Summary

Enriched the orchestrator system prompt (`buildOrchestratorPrompt` in `src/agents/orchestrator.ts`) with five new context sections so the orchestrator can guide users effectively. The prompt was refactored from a monolithic string into composable, independently testable section builders.

### New sections
1. **CLI reference** — compressed markdown table of all `grove` CLI commands (including insights, paths, plugins, upgrade)
2. **Pipeline paths** — serialized from `configPaths()` showing each path's description and step flow
3. **Skill catalog** — lists installed skills from `loadSkills()` with descriptions and suggested steps
4. **Budget context** — live snapshot of today/week spend vs limits from `db.costToday()`, `db.costWeek()`, `budgetGet()`
5. **Event reference** — full documentation of `spawn_worker` options (including `path_name` and `depends_on`) and `task_update`

### Reviewer feedback addressed
- Added 4 missing CLI commands to reference table
- Fixed `handleOrchestratorEvent` to use `event.task` for title (not `event.prompt`)
- Added `depends_on` passthrough to handler INSERT for cross-tree dependency chains

All 15 orchestrator tests pass (7 original + 8 new).

## Files Modified

- `src/agents/orchestrator.ts` — enriched prompt builder with composable sections + handler fixes
- `tests/agents/orchestrator.test.ts` — 8 new tests for all new sections

## Next Steps

- None — feature complete and reviewer feedback addressed. Ready for merge.
