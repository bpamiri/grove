# Task: W-079
## Display broker events in orchestrator chat as system messages

### Description
## Problem
Broker events (merges, PR creations, stalls, eval results, budget warnings) are sent to the orchestrator via `safeSend()` → `orchestrator.sendMessage()` in `orchestrator-feedback.ts`. The orchestrator processes these and responds, but the original event message is never displayed in the GUI chat panel. Users see the orchestrator's response ("W-007 merged, no follow-up needed") without the triggering event ("[event] W-007 merged (PR #2018)"), leaving them confused about what the orchestrator is reacting to.

## Scope
In `orchestrator-feedback.ts`, each `safeSend()` call should also emit the event message to the chat UI as a `system` message, so users see the full event→response flow:

```
[system]  [event] W-007 merged (PR #2018). Plan next steps if needed.
[orchestrator]  W-007 merged successfully. No follow-up needed.
```

### Implementation
1. In `safeSend()`, before calling `orchestrator.sendMessage()`, also call `bus.emit('message:new', { message: { source: 'system', channel: 'main', content: message } })` and `db.addMessage('system', message)` to persist and broadcast the event to WebSocket clients.
2. Style system messages distinctly in the chat UI — they already have styling in `Chat.tsx` (`messageStyle` returns `bg-zinc-800/50 text-zinc-500 text-xs` for source `system`).
3. Consider adding a collapsible/dimmed style for high-frequency events (stall alerts) to avoid flooding the chat with repeated stall warnings.

## Key Files
- `src/broker/orchestrator-feedback.ts` — `safeSend()` function (line 31-37)
- `src/broker/event-bus.ts` — `message:new` event
- `src/broker/db.ts` — `addMessage()` for persistence
- `web/src/components/Chat.tsx` or `web/src/components/AgentDialogue.tsx` — system message rendering

## Notes
- The W-072 stall spam showed why this matters — 14+ stall alerts were sent to the orchestrator but the user had no idea repeated alerts were firing until they saw the orchestrator's confused responses.
- Consider deduplication: if the same event type fires repeatedly for the same task (e.g., stall alerts), collapse them in the UI ("Worker stalled (×8)") rather than showing 8 identical system messages.

### Workflow
This task follows the **development** path.

### Strategy
You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.

### Step Instructions
Implement the task. Commit your changes with conventional commit messages.

### Git Branch
Work on branch: `grove/W-079-display-broker-events-in-orchestrator-ch`
Commit message format: conventional commits — `feat: (W-079) description`, `fix: (W-079) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Checkpoint — Resuming from prior session
- **Step:** implement (index 1)
- **Last commit:** e47561cc7a8becb0eb537488553739368cdb9679
- **Files modified:** .claude/CLAUDE.md, src/broker/orchestrator-feedback.ts, tests/broker/orchestrator-feedback.test.ts
- **Summary:** # Session Summary: W-070

## Summary

Implemented the `security-audit` built-in pipeline path with four steps (scan → analyze → report → remediate) and a comprehensive security-audit skill. The path is now available as a default alongside development, research, and adversarial.

### Key Design Decisions

- **Single skill, four steps**: One `security-audit` skill serves all pipeline steps, with step-specific sections. Matches the pattern used by other skills.
- **Read-only analyze step**: The analysis/triage step runs in read-only sandbox — it reads scan results and classifies findings without modifying source files. On failure, it loops back to `scan`.
- **Best-effort remediation**: The `remediate` step uses `on_failure: "$done"` — the pipeline succeeds even if auto-fixes fail, since the scan and report are the primary deliverables.
- **Structured JSON interchange**: Each step produces a JSON file (`.grove/security-scan.json`, `.grove/security-analysis.json`, `.grove/security-remediation.json`) that downstream steps consume, plus a human-readable `.grove/security-report.md`.
- **OWASP Top 10 coverage**: The skill includes a lookup table mapping each OWASP category to concrete patterns the worker should search for.
- **False-positive heuristics**: The analyze step includes specific rules for common false positives (test fixtures, env var references, ORM parameterization, etc.).

## Files Modified

- `src/shared/types.ts` — added `security-audit` to `DEFAULT_PATHS`
- `grove.yaml.example` — updated built-in path list comment, added commented-out customization example
- `skills/security-audit/skill.yaml` — new skill metadata
- `skills/security-audit/skill.md` — comprehensive skill instructions for all 4 steps
- `.grove/session-summary.md` — this file

## Next Steps

- None — feature is complete. Tests pass. Ready for commit.

- **Cost so far:** $0.00

Continue from where you left off. The WIP commit contains your in-progress work.
Do NOT repeat work that's already committed.

### Previous Session
# Session Summary: W-070

## Summary

Implemented the `security-audit` built-in pipeline path with four steps (scan → analyze → report → remediate) and a comprehensive security-audit skill. The path is now available as a default alongside development, research, and adversarial.

### Key Design Decisions

- **Single skill, four steps**: One `security-audit` skill serves all pipeline steps, with step-specific sections. Matches the pattern used by other skills.
- **Read-only analyze step**: The analysis/triage step runs in read-only sandbox — it reads scan results and classifies findings without modifying source files. On failure, it loops back to `scan`.
- **Best-effort remediation**: The `remediate` step uses `on_failure: "$done"` — the pipeline succeeds even if auto-fixes fail, since the scan and report are the primary deliverables.
- **Structured JSON interchange**: Each step produces a JSON file (`.grove/security-scan.json`, `.grove/security-analysis.json`, `.grove/security-remediation.json`) that downstream steps consume, plus a human-readable `.grove/security-report.md`.
- **OWASP Top 10 coverage**: The skill includes a lookup table mapping each OWASP category to concrete patterns the worker should search for.
- **False-positive heuristics**: The analyze step includes specific rules for common false positives (test fixtures, env var references, ORM parameterization, etc.).

## Files Modified

- `src/shared/types.ts` — added `security-audit` to `DEFAULT_PATHS`
- `grove.yaml.example` — updated built-in path list comment, added commented-out customization example
- `skills/security-audit/skill.yaml` — new skill metadata
- `skills/security-audit/skill.md` — comprehensive skill instructions for all 4 steps
- `.grove/session-summary.md` — this file

## Next Steps

- None — feature is complete. Tests pass. Ready for commit.


### Files Already Modified
.claude/CLAUDE.md
src/broker/orchestrator-feedback.ts
tests/broker/orchestrator-feedback.test.ts

### Session Summary Instructions
Before finishing, create `.grove/session-summary.md` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains (if anything)

### Working Guidelines
- Make atomic commits: `feat: (W-079) description`, `fix: (W-079) description`
- Run tests if available before marking done
- Write the session summary file before finishing
- Do NOT push to remote — Grove handles that
