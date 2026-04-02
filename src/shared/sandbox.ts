// Grove v3 — Worker sandbox: guard hooks + CLAUDE.md overlay deployment
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./worktree";

// ---------------------------------------------------------------------------
// Guard hook generation
// ---------------------------------------------------------------------------

interface GuardHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

function buildGuardHooks(worktreePath: string): GuardHookEntry[] {
  return [
    { matcher: "Bash", hooks: [{ type: "command", command: `grove _guard bash-danger "${worktreePath}"` }] },
    { matcher: "Write", hooks: [{ type: "command", command: `grove _guard edit-boundary "${worktreePath}"` }] },
    { matcher: "Edit", hooks: [{ type: "command", command: `grove _guard edit-boundary "${worktreePath}"` }] },
  ];
}

// ---------------------------------------------------------------------------
// Overlay generation
// ---------------------------------------------------------------------------

function readClaudeMd(treePath: string): string {
  const expanded = expandHome(treePath);
  const claudeMdPath = join(expanded, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try { return readFileSync(claudeMdPath, "utf-8"); } catch { return ""; }
  }
  return "";
}

export interface OverlayContext {
  taskId: string;
  title: string;
  description?: string | null;
  treePath: string;
  branch?: string | null;
  pathName?: string;
  workerInstructions?: string | null;
  sessionSummary?: string | null;
  filesModified?: string | null;
  stepPrompt?: string;
  seedSpec?: string | null;
  reviewFeedback?: string | null;
  checkpoint?: {
    stepId: string;
    stepIndex: number;
    commitSha: string | null;
    filesModified: string[];
    sessionSummary: string;
    costSoFar: number;
  } | null;
}

export interface ReviewOverlayContext {
  taskId: string;
  title: string;
  description?: string | null;
  treePath: string;
  stepPrompt?: string;
  planContent: string;
  priorFeedback?: string[];
}

/** Build the CLAUDE.md overlay content for a worker's worktree */
export function buildOverlay(ctx: OverlayContext): string {
  const claudeMdContent = readClaudeMd(ctx.treePath);
  const parts: string[] = [];

  parts.push(`# Task: ${ctx.taskId}`);
  parts.push(`## ${ctx.title}`);
  parts.push("");

  if (ctx.description) {
    parts.push("### Description");
    parts.push(ctx.description);
    parts.push("");
  }

  if (ctx.seedSpec) {
    parts.push("### Seed (Design Spec)");
    parts.push("The following design spec was produced during a brainstorming session. Follow it closely.");
    parts.push("");
    parts.push(ctx.seedSpec);
    parts.push("");
  }

  if (ctx.pathName) {
    parts.push("### Workflow");
    parts.push(`This task follows the **${ctx.pathName}** path.`);
    parts.push("");
  }

  if (ctx.workerInstructions) {
    parts.push("### Worker Instructions");
    parts.push(ctx.workerInstructions);
    parts.push("");
  }

  parts.push("### Strategy");
  parts.push("You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.");
  parts.push("");

  if (ctx.stepPrompt) {
    parts.push("### Step Instructions");
    parts.push(ctx.stepPrompt);
    parts.push("");
  }

  if (ctx.branch) {
    parts.push("### Git Branch");
    parts.push(`Work on branch: \`${ctx.branch}\``);
    parts.push(`Commit message format: conventional commits — \`feat: (${ctx.taskId}) description\`, \`fix: (${ctx.taskId}) description\`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.`);
    parts.push("");
  }

  if (ctx.reviewFeedback) {
    parts.push("### Reviewer Feedback");
    parts.push("The adversarial reviewer rejected your previous plan for the following reasons. Revise your plan to address each point:");
    parts.push("");
    parts.push(ctx.reviewFeedback);
    parts.push("");
  }

  if (ctx.checkpoint) {
    parts.push("### Checkpoint — Resuming from prior session");
    parts.push(`- **Step:** ${ctx.checkpoint.stepId} (index ${ctx.checkpoint.stepIndex})`);
    if (ctx.checkpoint.commitSha) {
      parts.push(`- **Last commit:** ${ctx.checkpoint.commitSha}`);
    }
    if (ctx.checkpoint.filesModified.length > 0) {
      parts.push(`- **Files modified:** ${ctx.checkpoint.filesModified.join(", ")}`);
    }
    parts.push(`- **Summary:** ${ctx.checkpoint.sessionSummary}`);
    parts.push(`- **Cost so far:** $${ctx.checkpoint.costSoFar.toFixed(2)}`);
    parts.push("");
    parts.push("Continue from where you left off. The WIP commit contains your in-progress work.");
    parts.push("Do NOT repeat work that's already committed.");
    parts.push("");
  }

  if (ctx.sessionSummary) {
    parts.push("### Previous Session");
    parts.push(ctx.sessionSummary);
    parts.push("");
  }

  if (ctx.filesModified) {
    parts.push("### Files Already Modified");
    parts.push(ctx.filesModified);
    parts.push("");
  }

  if (claudeMdContent) {
    parts.push("### Repository Context (from CLAUDE.md)");
    parts.push(claudeMdContent);
    parts.push("");
  }

  parts.push("### Session Summary Instructions");
  parts.push("Before finishing, create `.grove/session-summary.md` in the worktree with:");
  parts.push("- **Summary**: What you accomplished");
  parts.push("- **Files Modified**: List of files changed");
  parts.push("- **Next Steps**: What remains (if anything)");
  parts.push("");

  parts.push("### Working Guidelines");
  if (ctx.branch) {
    parts.push(`- Make atomic commits: \`feat: (${ctx.taskId}) description\`, \`fix: (${ctx.taskId}) description\``);
  }
  parts.push("- Run tests if available before marking done");
  parts.push("- Write the session summary file before finishing");
  parts.push("- Do NOT push to remote — Grove handles that");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Sandbox deployment
// ---------------------------------------------------------------------------

/** Deploy guard hooks + CLAUDE.md overlay into a worktree */
export function deploySandbox(worktreePath: string, ctx: OverlayContext): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Write settings.local.json with guard hooks (worktree path hardcoded into scripts)
  const settingsPath = join(claudeDir, "settings.local.json");
  const hooks = buildGuardHooks(worktreePath);
  let finalSettings: any = {};

  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      finalSettings = { ...existing };
      // Remove old Grove hooks, add fresh ones
      if (existing.hooks?.PreToolUse) {
        const nonGrove = existing.hooks.PreToolUse.filter(
          (h: any) => !h.hooks?.some?.((hook: any) => hook.command?.includes("GROVE_TASK_ID")),
        );
        finalSettings.hooks = { ...existing.hooks, PreToolUse: [...nonGrove, ...hooks] };
      } else {
        finalSettings.hooks = { ...(existing.hooks || {}), PreToolUse: hooks };
      }
    } catch {
      finalSettings = { hooks: { PreToolUse: hooks } };
    }
  } else {
    finalSettings = { hooks: { PreToolUse: hooks } };
  }

  writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2) + "\n");

  // Write CLAUDE.md overlay
  const overlayPath = join(claudeDir, "CLAUDE.md");
  writeFileSync(overlayPath, buildOverlay(ctx) + "\n");
}

/** Short trigger prompt for new tasks */
export function triggerPrompt(taskId: string): string {
  return `Execute the task described in your CLAUDE.md instructions. Task ID: ${taskId}. Follow all working guidelines. Write a session summary before finishing.`;
}

/** Short trigger prompt for resumed tasks */
export function resumeTriggerPrompt(taskId: string): string {
  return `Resume the task described in your CLAUDE.md instructions. Task ID: ${taskId}. Continue from where the last session left off. Write an updated session summary before finishing.`;
}

// ---------------------------------------------------------------------------
// Review sandbox — read-only with narrow write exception
// ---------------------------------------------------------------------------

/** Build CLAUDE.md overlay for an adversarial reviewer session */
export function buildReviewOverlay(ctx: ReviewOverlayContext): string {
  const parts: string[] = [];

  parts.push(`# Review: ${ctx.taskId}`);
  parts.push(`## ${ctx.title}`);
  parts.push("");

  parts.push("### Role");
  parts.push("You are an adversarial reviewer. Your job is to rigorously critique the plan below.");
  parts.push("You CANNOT modify any code or files except `.grove/review-result.json`.");
  parts.push("You MUST read the plan carefully, review the codebase for context, and write your verdict.");
  parts.push("");

  if (ctx.description) {
    parts.push("### Task Description");
    parts.push(ctx.description);
    parts.push("");
  }

  if (ctx.stepPrompt) {
    parts.push("### Review Criteria");
    parts.push(ctx.stepPrompt);
    parts.push("");
  }

  parts.push("### Plan Under Review");
  parts.push("```markdown");
  parts.push(ctx.planContent);
  parts.push("```");
  parts.push("");

  if (ctx.priorFeedback && ctx.priorFeedback.length > 0) {
    parts.push("### Prior Review History");
    parts.push("The plan has been revised in response to earlier feedback. Here is the history:");
    parts.push("");
    for (let i = 0; i < ctx.priorFeedback.length; i++) {
      parts.push(`**Round ${i + 1} feedback:**`);
      parts.push(ctx.priorFeedback[i]);
      parts.push("");
    }
  }

  parts.push("### Output Instructions");
  parts.push("After your review, write your verdict to `.grove/review-result.json` in the worktree:");
  parts.push("```json");
  parts.push('{ "approved": true, "feedback": "Brief explanation of why the plan is approved" }');
  parts.push("```");
  parts.push("or:");
  parts.push("```json");
  parts.push('{ "approved": false, "feedback": "Detailed feedback explaining what needs to change and why" }');
  parts.push("```");
  parts.push("");
  parts.push("**Rules:**");
  parts.push("- You must explicitly approve (set `approved: true`) — silence or lack of objection is NOT approval");
  parts.push("- If rejecting, be specific: name the exact issue and what should change");
  parts.push("- You may read any file in the codebase to verify claims in the plan");
  parts.push("- Do NOT modify any file except `.grove/review-result.json`");

  return parts.join("\n");
}

function buildReviewGuardHooks(worktreePath: string): GuardHookEntry[] {
  return [
    { matcher: "Bash", hooks: [{ type: "command", command: `grove _guard review-bash "${worktreePath}"` }] },
    { matcher: "Write", hooks: [{ type: "command", command: `grove _guard review-write "${worktreePath}"` }] },
    { matcher: "Edit", hooks: [{ type: "command", command: 'echo "BLOCKED: Reviewer cannot edit files" && exit 2' }] },
  ];
}

/** Deploy review sandbox (stricter than worker) */
export function deployReviewSandbox(worktreePath: string, ctx: ReviewOverlayContext): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.local.json");
  const hooks = buildReviewGuardHooks(worktreePath);
  const finalSettings = { hooks: { PreToolUse: hooks } };

  writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2) + "\n");

  const overlayPath = join(claudeDir, "CLAUDE.md");
  writeFileSync(overlayPath, buildReviewOverlay(ctx) + "\n");
}

/** Trigger prompt for reviewer sessions */
export function reviewTriggerPrompt(taskId: string): string {
  return `Review the plan described in your CLAUDE.md instructions. Task ID: ${taskId}. Read the plan carefully, examine the codebase for context, and write your verdict to .grove/review-result.json.`;
}

/** Read review feedback from worktree if present */
export function readReviewFeedback(worktreePath: string): string | null {
  const feedbackPath = join(worktreePath, ".grove", "review-feedback.md");
  if (existsSync(feedbackPath)) {
    try { return readFileSync(feedbackPath, "utf-8"); } catch { return null; }
  }
  return null;
}
