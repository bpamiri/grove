# Agent Pipelines with Skill Injection

**Date:** 2026-04-02
**Status:** Approved
**Breaking:** Yes (config v2 → v3)

## Problem

Grove's pipeline steps mix two execution models: agent-based steps (worker, review) and code-based steps (gate, merge). The code-based steps are the primary source of dogfooding failures. Code gates encode rigid assumptions about agent output — e.g., "commits must exist" fails when an agent legitimately makes no commits on a research task. Agents handle variance; code predicates don't.

As a one-person project, reimplementing judgment logic (evaluation, review, merge) that Claude Code and its skill ecosystem already do — and will keep improving — is unsustainable. Grove's durable value is workflow coordination (dispatch, sequencing, cost tracking, multi-repo orchestration, GUI), not agent intelligence.

## Solution

Replace all code-based pipeline steps with agent-based steps. Add a skill library system that lets users install, manage, and assign skills to pipeline steps. Skills are Claude Code skill files — when injected into a worktree, Claude Code discovers and follows them natively.

**Core principle:** Grove coordinates agents. Skills make agents smart. Claude Code is the agent.

## Step Engine Simplification

### Before (5 step types)

```
worker  → spawn Claude Code session (read-write)
gate    → run in-process code checks (evaluator.ts)
review  → spawn Claude Code session (read-only)
merge   → run in-process merge code (manager.ts)
verdict → pause for human
```

### After (2 step types)

```
worker  → spawn Claude Code session with injected skills
verdict → pause for human
```

Every step that does work is a `worker`. The difference between an "implement" worker and a "review" worker is the skills injected and the sandbox permissions, configured at the step level:

```yaml
steps:
  - id: review
    type: worker
    skills: [code-review]
    sandbox: read-only
    result_file: .grove/review-result.json
    result_key: approved
    on_failure: implement
    max_retries: 2
```

### Step config fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Step identifier (used in transitions) |
| `type` | `"worker"` or `"verdict"` | Execution type |
| `skills` | string[] | Skills to inject from the library |
| `sandbox` | `"read-write"` or `"read-only"` | Guard hook profile. Default: `read-write` |
| `prompt` | string | Task-specific context injected into CLAUDE.md overlay |
| `result_file` | string | Path (relative to worktree) to a JSON result file the agent writes |
| `result_key` | string | Key in the result JSON that indicates pass (`true`) or fail (`false`) |
| `on_success` | string | Next step ID or `$done`. Default: next step in list |
| `on_failure` | string | Step ID to jump to on failure. Default: task fails |
| `max_retries` | number | Max retry attempts before fatal failure |

### Completion detection

If `result_file` is set, the engine reads it after the agent exits:
- Key is truthy → success, follow `on_success`
- Key is falsy or file missing → failure, follow `on_failure`

If `result_file` is not set, fall back to exit code (0 = success).

### Sandbox modes

The `sandbox` field maps to guard hook deployment:

- **`read-write`** (default): Standard guard hooks (blocks dangerous commands)
- **`read-only`**: Review guard hooks (blocks Write/Edit except `.grove/` paths)

Both already exist in `sandbox.ts`. The only change is driving the choice from `step.sandbox` instead of from the step type.

## Skill Library System

### Storage

Skills live in `~/.grove/skills/`. Each skill is a directory with a manifest and content files:

```
~/.grove/skills/
├── code-review/
│   ├── skill.yaml
│   └── skill.md
├── merge-handler/
│   ├── skill.yaml
│   └── skill.md
└── tdd/
    ├── skill.yaml
    └── skill.md
```

### Manifest format (`skill.yaml`)

```yaml
name: code-review
version: 1.0.0
description: Guided code review — runs tests, checks diff quality, verifies task completion
author: grove-official
source: https://github.com/grove-skills/code-review

# Hints for the GUI about which steps this skill is designed for
suggested_steps: [review]

# Files to inject into the worktree (relative to skill dir)
files:
  - skill.md
```

### Skill content format

Skill files are standard Claude Code skill files (markdown with YAML frontmatter). No new format. Example:

```markdown
---
name: grove-code-review
description: Use when reviewing code changes for a grove task
---

You are reviewing code changes made by a previous implementation agent.

## Checklist
1. Run the test suite. Report results.
2. Check that commits exist on the branch.
3. Review the diff for code quality issues.
4. Verify the changes match the task description.
5. Check for security concerns.

## Judgment
If tests pass and the implementation satisfies the task, approve.
If tests fail, reject with the specific failure output.
If no commits exist but the task is research/analysis, that's acceptable.
Use judgment for edge cases.

## Output
Write your verdict to `.grove/review-result.json`:
{ "approved": true/false, "feedback": "..." }
```

### Installation sources

Skills can be installed from:
- **Git URL**: `grove skills install https://github.com/user/skill-repo` — clones into `~/.grove/skills/<name>/`
- **Local path**: `grove skills install ./my-skill` — copies or symlinks into `~/.grove/skills/<name>/`

### CLI commands

```bash
grove skills install <git-url|local-path>   # install a skill
grove skills list                            # show installed skills
grove skills remove <name>                   # remove from library
```

## Skill Injection into Worktrees

### Injection flow

```
Step config says: skills: [code-review, security-audit]
  → Grove reads skill manifests from ~/.grove/skills/
  → Copies skill files into worktree/.claude/skills/<skill-name>/
  → Spawns Claude Code session in worktree
  → Claude discovers skills naturally via .claude/skills/
```

### Injected structure

```
worktree/
├── .claude/
│   └── skills/
│       ├── code-review/
│       │   └── skill.md
│       └── security-audit/
│           └── skill.md
├── src/
└── ...
```

### Step prompt vs skill content

Both get injected, serving different purposes:
- **Step prompt** (from grove.yaml `prompt` field) → task-specific context, injected into CLAUDE.md overlay
- **Skill content** (from skill.md files) → methodology/process, injected into `.claude/skills/`

Claude sees both. The step prompt says what to do; the skills say how.

### When no skills are assigned

The worker gets a plain Claude Code session with just the step prompt in the CLAUDE.md overlay. Skills are additive, not required.

### Missing skills

If a step references a skill that isn't installed, the step engine logs a warning and proceeds without it. The task doesn't fail — the agent just won't have that skill's guidance. This prevents a missing skill from breaking the entire pipeline.

### Cleanup

Injected skills are part of the worktree. When the worktree is cleaned up after completion, skills go with it.

## Worker Spawn Changes

Updated spawn sequence:

1. Create/reuse worktree (unchanged)
2. Build CLAUDE.md overlay — step prompt, task context, retry feedback (unchanged)
3. **Inject skills** into `worktree/.claude/skills/` (new)
4. Deploy sandbox guard hooks driven by `step.sandbox` (changed: was driven by step type)
5. Spawn Claude Code session (unchanged)
6. Monitor stdout, parse cost, detect completion (unchanged)
7. **Read result file** if `step.result_file` is configured (new)

## Default Pipeline Paths

```yaml
paths:
  development:
    description: Standard dev workflow with review
    steps:
      - id: implement
        type: worker
      - id: review
        type: worker
        skills: [code-review]
        sandbox: read-only
        result_file: .grove/review-result.json
        result_key: approved
        on_failure: implement
        max_retries: 2
      - id: merge
        type: worker
        skills: [merge-handler]
        result_file: .grove/merge-result.json
        result_key: merged
        on_success: $done

  adversarial:
    description: Plan review loop before implementation
    steps:
      - id: plan
        type: worker
      - id: review-plan
        type: worker
        skills: [adversarial-review]
        sandbox: read-only
        result_file: .grove/review-result.json
        result_key: approved
        on_failure: plan
        max_retries: 3
      - id: implement
        type: worker
      - id: review-code
        type: worker
        skills: [code-review]
        sandbox: read-only
        result_file: .grove/review-result.json
        result_key: approved
        on_failure: implement
        max_retries: 2
      - id: merge
        type: worker
        skills: [merge-handler]
        result_file: .grove/merge-result.json
        result_key: merged
        on_success: $done

  research:
    description: Research task — produces a report, no code changes
    steps:
      - id: research
        type: worker
      - id: report
        type: worker
        skills: [research-report]
        on_success: $done
```

## Starter Skills

Grove ships 4 skills that make the default paths work out of the box. They live in the repo under `skills/` and get copied into `~/.grove/skills/` on first run if not already present.

| Skill | Purpose | Default step |
|-------|---------|-------------|
| `code-review` | Guided review — run tests, check diff, verify task completion, write verdict | `development.review` |
| `merge-handler` | Push branch, create PR via `gh`, monitor CI, merge or report failure | `development.merge` |
| `adversarial-review` | Strict plan critique — backwards compat, edge cases, test strategy | `adversarial.review-plan` |
| `research-report` | Summarize findings into `.grove/report.md` | `research.report` |

These are standard skills. Users can replace them with alternatives.

## Files Removed

| File | Reason |
|------|--------|
| `src/agents/evaluator.ts` | Code gates replaced by review skills. `buildRetryPrompt()` moves to shared util. |
| `src/agents/reviewer.ts` | Folded into worker.ts — review is a worker with `sandbox: read-only` and `result_file`. |
| `src/merge/manager.ts` | Merge logic replaced by merge-handler skill. |
| `src/merge/github.ts` | Used only by manager.ts. Merge skill uses `gh` CLI directly. |

## Files Changed

| File | Change |
|------|--------|
| `src/engine/step-engine.ts` | Remove `gate`, `review`, `merge` cases. Add skill injection call. Add result file reading. |
| `src/agents/worker.ts` | Add skill injection before spawn. Accept `sandbox` mode. Generalize result file parsing. |
| `src/shared/sandbox.ts` | Drive guard hook choice from `step.sandbox` instead of step type. Merge review overlay into main overlay with read-only flag. |
| `src/shared/types.ts` | Update `PipelineStep`: add `skills`, `sandbox`, `result_file`, `result_key`. Remove `gate` from type union. Update `DEFAULT_PATHS`. |
| `src/plugins/types.ts` | Remove `gate:custom` hook type. Keep `step:pre`, `step:post`. |

## Files Added

| File | Purpose |
|------|--------|
| `src/skills/library.ts` | Skill library: load manifests, install, remove, list |
| `src/skills/injector.ts` | Copy skill files into worktree `.claude/skills/` |
| `src/cli/commands/skills.ts` | CLI: `grove skills install/list/remove` |
| `skills/code-review/` | Bundled starter skill |
| `skills/merge-handler/` | Bundled starter skill |
| `skills/adversarial-review/` | Bundled starter skill |
| `skills/research-report/` | Bundled starter skill |

## Migration

**Config version:** v2 → v3 (breaking)

The `grove config migrate` command transforms existing configs:
- `type: gate` → `type: worker` + `skills: [code-review]` + `sandbox: read-only` + `result_file` + `result_key`
- `type: merge` → `type: worker` + `skills: [merge-handler]` + `result_file` + `result_key`
- `type: review` → `type: worker` + `sandbox: read-only` + `result_file` + `result_key` (preserves existing prompt/skills)

Clean break — no dual-mode period. Old step types are removed from the engine.

## Out of Scope

- GUI for skill management (CLI only for now)
- Skill versioning/dependency resolution
- Skill marketplace/registry
- Multi-skill conflict resolution (multiple skills on one step just all get injected)
- Skill-to-skill dependencies
