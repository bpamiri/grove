// Grove v3 — Worker sandbox: guard hooks + CLAUDE.md overlay deployment
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./worktree";

// ---------------------------------------------------------------------------
// Guard hook generation
// ---------------------------------------------------------------------------

const BLOCKED_BASH_PATTERNS = [
  "git push", "git reset --hard", "rm -rf /", "sudo ",
];

const SAFE_BASH_PREFIXES = [
  "git status", "git log", "git diff", "git show", "git blame", "git branch",
  "git add", "git commit", "git merge", "git cherry-pick", "git checkout", "git rebase",
  "git stash", "git tag", "git fetch",
  "ls", "cat", "head", "tail", "find", "grep", "rg", "wc", "which", "pwd", "echo",
  "tree", "file", "stat", "du", "df", "env", "printenv",
  "bun ", "bun test", "npm ", "npx ", "node ", "python ", "make ", "cargo ",
];

interface GuardHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

function bashDangerGuard(): string {
  const checks = BLOCKED_BASH_PATTERNS.map(
    (p) => `echo "$CLAUDE_TOOL_INPUT" | grep -qiF '${p}' && echo "BLOCKED: ${p} is not allowed in Grove workers" && exit 2`
  ).join("; ");
  return `${checks}; exit 0`;
}

function writeEditPathBoundary(worktreePath: string): string {
  // Hardcode the worktree path. Use if/elif instead of case (case breaks with semicolons).
  return [
    `GROVE_WT="${worktreePath}"`,
    'FILE_PATH=$(echo "$CLAUDE_TOOL_INPUT" | grep -o \'"file_path":"[^"]*"\' | head -1 | sed \'s/"file_path":"//;s/"$//\')',
    '[ -z "$FILE_PATH" ] && exit 0',
    'echo "$FILE_PATH" | grep -q "^$GROVE_WT" && exit 0',
    'echo "$FILE_PATH" | grep -q "^/tmp/" && exit 0',
    'echo "$FILE_PATH" | grep -q "^/private/tmp/" && exit 0',
    'echo "BLOCKED: $FILE_PATH is outside worktree" && exit 2',
  ].join("; ");
}

function buildGuardHooks(worktreePath: string): GuardHookEntry[] {
  return [
    { matcher: "Bash", hooks: [{ type: "command", command: bashDangerGuard() }] },
    { matcher: "Write", hooks: [{ type: "command", command: writeEditPathBoundary(worktreePath) }] },
    { matcher: "Edit", hooks: [{ type: "command", command: writeEditPathBoundary(worktreePath) }] },
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
  sessionSummary?: string | null;
  filesModified?: string | null;
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

  if (ctx.pathName) {
    parts.push("### Workflow");
    parts.push(`This task follows the **${ctx.pathName}** path.`);
    parts.push("");
  }

  parts.push("### Strategy");
  parts.push("You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.");
  parts.push("");

  if (ctx.branch) {
    parts.push("### Git Branch");
    parts.push(`Work on branch: \`${ctx.branch}\``);
    parts.push(`Commit message format: conventional commits — \`feat: (${ctx.taskId}) description\`, \`fix: (${ctx.taskId}) description\`, etc. Task ID goes in the subject after the colon, NOT in the scope parentheses.`);
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
