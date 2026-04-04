# Review: W-068
## Enrich orchestrator system prompt with full CLI docs, MCP server, and skill catalog

### Role
You are an adversarial reviewer. Your job is to rigorously critique the plan below.
You CANNOT modify any code or files except `.grove/review-result.json`.
You MUST read the plan carefully, review the codebase for context, and write your verdict.

### Task Description
## Problem
The orchestrator's system prompt (`buildOrchestratorPrompt` in `src/agents/orchestrator.ts:102`) only knows about trees, active tasks, and recent messages. It has no knowledge of:
- Full CLI commands and their usage
- Available pipeline paths and their step definitions
- Installed skills and their capabilities
- MCP server availability
- Budget status / cost context

This limits the orchestrator's ability to guide users effectively.

## Scope
1. **CLI reference** — inject a concise summary of all `grove` CLI commands into the system prompt (from `src/cli/commands/help.ts` or hardcoded reference).
2. **Pipeline paths** — serialize the `paths:` section from grove.yaml into the prompt so the orchestrator knows what pipelines exist and what steps they contain.
3. **Skill catalog** — list installed skills (from `skills/` dir + built-in) with one-line descriptions.
4. **Budget context** — include current spend vs. limits so the orchestrator can make cost-aware decisions.
5. **Grove event reference** — document all available event types the orchestrator can emit (currently only `spawn_worker` and `task_update` — but there may be more to add).

## Key Files
- `src/agents/orchestrator.ts` — `buildOrchestratorPrompt()` function (line 102-151)
- `src/skills/` — built-in skill injector
- `src/cli/commands/help.ts` — CLI reference

## Notes
Keep the prompt lean — use compressed reference tables rather than verbose documentation. The context window budget matters.

### Plan Under Review
```markdown
# Session Summary: W-068

## Summary

Addressed three issues from adversarial reviewer feedback on the enriched orchestrator system prompt:

1. **CLI reference completed** — Added 4 missing commands (`insights`, `paths`, `plugins`, `upgrade`) to `buildCliReferenceSection()`.
2. **Handler `task` field fixed** — Changed `handleOrchestratorEvent` INSERT to use `event.task` for title and `event.prompt` for description. Previously used `event.prompt` for both, meaning task titles were full implementation instructions.
3. **Handler `depends_on` passthrough fixed** — Added `depends_on` column to the INSERT statement so cross-tree dependency chains actually work. The column existed in the schema and was checked by dispatch, but the orchestrator handler silently dropped it.

All 15 tests pass (including updated CLI reference assertions).

## Files Modified

- `src/agents/orchestrator.ts` — 4 CLI rows added, handler INSERT fixed (title, depends_on)
- `tests/agents/orchestrator.test.ts` — 4 new assertions for missing CLI commands

## Next Steps

- None — all reviewer feedback addressed. Ready for re-review.

```

### Prior Review History
The plan has been revised in response to earlier feedback. Here is the history:

**Round 1 feedback:**
Three issues to address:

1. **CLI reference incomplete** — Task spec says 'all grove CLI commands' but 4 are missing: `insights` (cross-task analytics), `paths` (pipeline path management), `plugins` (plugin management), `upgrade` (binary updates). Fix: add 4 rows to the CLI reference table in `buildCliReferenceSection()`.

2. **`depends_on` documented but silently dropped** — Event reference (line 152-171) documents `depends_on` as a spawn_worker option, but `handleOrchestratorEvent` (line 414-427) doesn't include it in the INSERT statement. The orchestrator will think it's setting up task dependencies when it's not. Fix: either add `depends_on` to the INSERT in the handler, or remove it from the event reference docs until the handler supports it.

3. **`task` field documented but handler ignores it** — Event reference says `task` is the 'short title' (required), but the handler uses `event.prompt` for both title and description (line 418). `event.task` is never stored. Fix: change the INSERT to use `event.task` for title and `event.prompt` for description.

Issues 2 and 3 are pre-existing handler bugs, but documenting them as working features makes them worse — the orchestrator will now actively rely on broken behavior. The fix for all three is small.

### Output Instructions
After your review, write your verdict to `.grove/review-result.json` in the worktree:
```json
{ "approved": true, "feedback": "Brief explanation of why the plan is approved" }
```
or:
```json
{ "approved": false, "feedback": "Detailed feedback explaining what needs to change and why" }
```

**Rules:**
- You must explicitly approve (set `approved: true`) — silence or lack of objection is NOT approval
- If rejecting, be specific: name the exact issue and what should change
- You may read any file in the codebase to verify claims in the plan
- Do NOT modify any file except `.grove/review-result.json`
