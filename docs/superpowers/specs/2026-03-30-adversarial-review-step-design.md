# Adversarial Review Step Type — Design Spec

**Issue**: #78
**Task**: W-038
**Date**: 2026-03-30

## Problem

The step engine supports `worker`, `gate`, and `merge` step types. There's no way to have two agents debate a plan before implementation — the planner and reviewer must be separate Claude sessions because models are poor self-critics.

## Solution: `review` Step Type

A new step type that spawns a read-only Claude CLI session to adversarially critique the output of a preceding worker step. On rejection, feedback is threaded back to the worker for revision, creating a plan-review loop.

## Path Config

```yaml
paths:
  adversarial:
    description: Adversarial planning with review loop
    steps:
      - plan:
          prompt: "Create a detailed implementation plan..."
      - review:
          type: review
          prompt: "Critique this plan for correctness, backwards compatibility..."
          on_failure: plan
          max_retries: 3
      - implement
      - evaluate
      - merge
```

## Architecture

### Reviewer Agent (`src/agents/reviewer.ts`)

Spawns a Claude CLI subprocess in the task's worktree:
- **Read-only sandbox**: Write/Edit hooks block everything except `.grove/review-result.json`
- **Prompt includes**: plan content (from `.grove/plan.md` or session summary), review criteria (from step prompt), prior review history
- **Output**: Claude writes `.grove/review-result.json` → `{ "approved": boolean, "feedback": "..." }`
- **On exit**: agent reads result file, maps to `onStepComplete` outcome

### Feedback Threading

When a review rejects the plan:
1. Reviewer writes feedback to `.grove/review-feedback.md` in worktree
2. `onStepComplete(taskId, "failure")` transitions to `on_failure` step (e.g., "plan")
3. When the plan worker re-spawns, `deploySandbox` detects `.grove/review-feedback.md` and includes it in the CLAUDE.md overlay
4. Planner sees: "The reviewer rejected your plan: [feedback]. Revise."

### Loop Termination

Follows the evaluator's rebase-failure-detection pattern:
- Each review rejection logs a `review_rejected` event
- Before each review, count prior `review_rejected` events for this task
- If count >= `step.max_retries` (default 3), return `fatal: true`
- Fatal outcome bypasses all retry/transition logic → task fails immediately

### Sandbox Differences from Worker

| Aspect | Worker | Reviewer |
|--------|--------|----------|
| Write/Edit | Allowed within worktree | Only `.grove/review-result.json` |
| Session summary | Required | Not written |
| Git commits | Expected | Blocked (no git add/commit) |
| Strategy text | "Complete end-to-end" | "You are an adversarial reviewer" |
| Overlay | Full task context | Plan content + review criteria |

## Type Changes

```typescript
// PipelineStep.type
type: "worker" | "gate" | "merge" | "review"

// AgentRole enum
Reviewer = "reviewer"

// EventType additions
ReviewStarted = "review_started"
ReviewApproved = "review_approved"
ReviewRejected = "review_rejected"

// EventBusMap additions
"review:started": { taskId: string; sessionId: string }
"review:approved": { taskId: string; feedback?: string }
"review:rejected": { taskId: string; feedback: string }
```

## Normalize Rules

- String shorthand `"review"` infers `type: "review"`
- Review steps auto-wire `on_failure` to nearest preceding worker (same as gates)

## DEFAULT_PATHS Addition

```typescript
adversarial: {
  description: "Adversarial planning with review loop",
  steps: [
    { id: "plan", type: "worker", prompt: "Create a detailed implementation plan..." },
    { id: "review", type: "review", prompt: "Critique this plan...", on_failure: "plan", max_retries: 3 },
    { id: "implement", type: "worker", prompt: "Implement the approved plan..." },
    { id: "evaluate", type: "gate", on_failure: "implement" },
    { id: "merge", type: "merge" },
  ],
}
```

## Files to Create

- `src/agents/reviewer.ts` — Reviewer agent

## Files to Modify

- `src/shared/types.ts` — Type additions
- `src/engine/normalize.ts` — `review` in TYPE_INFERENCE + auto-wire
- `src/engine/step-engine.ts` — `review` case in executeStep
- `src/shared/sandbox.ts` — Review overlay + review feedback inclusion
- `src/agents/worker.ts` — Read review feedback into overlay context
- `tests/engine/step-engine.test.ts` — Review step transition tests
- `tests/agents/reviewer.test.ts` — New test file

## Open Questions (Resolved)

- **Reviewer codebase access**: Yes, reviewer has full read access to the worktree (not just the plan file). This lets it verify references, check existing APIs, etc.
- **Structured plan format**: Freeform markdown (`.grove/plan.md`). Structure is enforced by the step prompt, not the framework.
- **Reuse evaluator infrastructure**: No. Reviewer is a subprocess (separate Claude session); evaluator runs in-process (no Claude). Different enough to warrant its own module.
- **Conversation history in UI**: Review feedback persists as events in the events table, visible in the task timeline.
