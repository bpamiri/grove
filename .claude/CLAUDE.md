# Task: W-071
## Create code-refactoring pipeline path (analysis, refactor, test, review)

### Description
## Problem
The `development` and `adversarial` paths are oriented around feature work. Refactoring tasks have different concerns: preserving behavior, maintaining test coverage, measuring complexity reduction.

## Scope
Create a `refactoring` path with these steps:

1. **analyze** (worker) — Identify refactoring targets: code smells, duplicated logic, high cyclomatic complexity, large files. Produce a structured analysis in `.grove/refactor-analysis.json`.
2. **plan** (worker) — Based on analysis, create a refactoring plan with before/after descriptions, risk assessment, and test strategy. Write to `.grove/refactor-plan.md`.
3. **implement** (worker) — Execute the refactoring plan. Commit atomically per logical change.
4. **verify** (gate) — Run full test suite, verify no behavior changes (same test results pre/post), check that complexity metrics improved.
5. **review** (worker, read-only) — Adversarial review focused on: accidental behavior changes, missing test coverage for refactored paths, API surface changes.
6. **merge** (worker) — Standard merge step.

### Skill
Create a `refactoring` skill with refactoring patterns, code smell detection guidance, and complexity measurement instructions.

## Key Files
- `grove.yaml` — add `refactoring` path definition
- `skills/refactoring/` — new skill directory

## Depends On
- W-069 (pipeline CRUD) — use the new API/CLI to create the path.

### Workflow
This task follows the **development** path.

### Strategy
You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.

### Step Instructions
Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.

### Git Branch
Work on branch: `grove/W-071-create-code-refactoring-pipeline-path-an`
Commit message format: conventional commits — `feat: (W-071) description`, `fix: (W-071) description`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.

### Checkpoint — Resuming from prior session
- **Step:** merge (index 3)
- **Files modified:** src/shared/types.ts
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
.claude/skills/code-review/skill.md
.claude/skills/merge-handler/skill.md
.grove/session-summary.md
docs/guides/configuration.md
docs/guides/custom-paths.md
grove.yaml.example
skills/refactoring/skill.md
skills/refactoring/skill.yaml
src/shared/types.ts
tests/engine/normalize-v3.test.ts
web/package-lock.json

### Session Summary Instructions
Before finishing, create `.grove/session-summary.md` in the worktree with:
- **Summary**: What you accomplished
- **Files Modified**: List of files changed
- **Next Steps**: What remains (if anything)

### Working Guidelines
- Make atomic commits: `feat: (W-071) description`, `fix: (W-071) description`
- Run tests if available before marking done
- Write the session summary file before finishing
