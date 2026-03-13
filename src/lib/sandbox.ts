// Grove v2 — Worker sandbox: guard hooks + overlay deployment
// Deploys .claude/settings.local.json (permission hooks) and .claude/CLAUDE.md
// (task context overlay) into each worktree before spawning a Claude worker.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "../core/db";
import type { GuardHookEntry, SandboxConfig } from "../types";

// ---------------------------------------------------------------------------
// Guard hook generation
// ---------------------------------------------------------------------------

/** Env-var guard prefix: no-op when not running under Grove */
const ENV_GUARD = '[ -z "$GROVE_TASK_ID" ] && exit 0';

/** Blocked bash patterns (catastrophic or push-related) */
const BLOCKED_BASH_PATTERNS = [
  "git push",
  "git reset --hard",
  "rm -rf /",
  "sudo ",
];

/** Safe bash prefixes that are always allowed */
const SAFE_BASH_PREFIXES = [
  // read-only git
  "git status", "git log", "git diff", "git show", "git blame", "git branch",
  // mutating git (local only)
  "git add", "git commit", "git merge", "git cherry-pick", "git checkout", "git rebase",
  "git stash", "git tag", "git fetch",
  // safe filesystem reads
  "ls", "cat", "head", "tail", "find", "grep", "rg", "wc", "which", "pwd", "echo",
  "tree", "file", "stat", "du", "df", "env", "printenv",
  // build/test
  "bun ", "bun test", "npm ", "npx ", "node ", "python ", "make ", "cargo ",
];

/** File-modifying bash commands that need path-boundary checks */
const FILE_MODIFY_COMMANDS = [
  "sed -i", "echo >", "echo >>", "tee ", "mv ", "cp ", "rm ", "mkdir ", "touch ",
  "chmod ", "chown ",
];

/**
 * Build a shell script for a PreToolUse hook command.
 * The script is a single-line bash command suitable for settings.local.json.
 */
function bashDangerGuard(): string {
  // Check the tool input (passed via $CLAUDE_TOOL_INPUT) for blocked patterns
  const checks = BLOCKED_BASH_PATTERNS.map(
    (p) => `echo "$CLAUDE_TOOL_INPUT" | grep -qiF '${p}' && echo "BLOCKED: ${p} is not allowed in Grove workers" && exit 2`
  ).join("; ");

  return `${ENV_GUARD}; ${checks}; exit 0`;
}

function bashSafeWhitelist(): string {
  // Extract the command from tool input and check against safe prefixes
  const checks = SAFE_BASH_PREFIXES.map(
    (p) => `echo "$CLAUDE_TOOL_INPUT" | grep -qF '"command"' && echo "$CLAUDE_TOOL_INPUT" | grep -qiF '${p}' && exit 0`
  ).join("; ");

  return `${ENV_GUARD}; ${checks}`;
}

function bashPathBoundary(): string {
  // For file-modifying commands, verify paths stay within the worktree
  const cmdChecks = FILE_MODIFY_COMMANDS.map((cmd) => `"${cmd}"`).join(" ");

  return [
    ENV_GUARD,
    'CMD=$(echo "$CLAUDE_TOOL_INPUT" | grep -o \'"command":"[^"]*"\' | head -1 | sed \'s/"command":"//;s/"$//\')',
    '[ -z "$CMD" ] && exit 0',
    `for pattern in ${cmdChecks}; do`,
    '  if echo "$CMD" | grep -qiF "$pattern"; then',
    '    if echo "$CMD" | grep -qE "(/[^ ]+)" | head -1; then',
    '      TARGET=$(echo "$CMD" | grep -oE "(/[^ ]+)" | tail -1)',
    '      case "$TARGET" in',
    '        "$GROVE_WORKTREE_PATH"*|/tmp/*|/dev/*) exit 0 ;;',
    '        /*) echo "BLOCKED: absolute path $TARGET is outside worktree" && exit 2 ;;',
    '      esac',
    '    fi',
    '    exit 0',
    '  fi',
    'done',
    'exit 0',
  ].join("; ");
}

function writeEditPathBoundary(): string {
  return [
    ENV_GUARD,
    'FILE_PATH=$(echo "$CLAUDE_TOOL_INPUT" | grep -o \'"file_path":"[^"]*"\' | head -1 | sed \'s/"file_path":"//;s/"$//\')',
    '[ -z "$FILE_PATH" ] && exit 0',
    'case "$FILE_PATH" in',
    '  "$GROVE_WORKTREE_PATH"*|/tmp/*|/dev/*) exit 0 ;;',
    '  /*) echo "BLOCKED: file_path $FILE_PATH is outside worktree boundary" && exit 2 ;;',
    'esac',
    'exit 0',
  ].join("; ");
}

/**
 * Build the guard hooks structure for settings.local.json.
 * Returns a SandboxConfig with PreToolUse hooks.
 */
export function buildGuardHooks(taskId: string, worktreePath: string): SandboxConfig {
  const hooks: GuardHookEntry[] = [
    // 1. Safe whitelist (runs first — fast exit for known-safe commands)
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: bashSafeWhitelist() }],
    },
    // 2. Danger guard (block catastrophic commands)
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: bashDangerGuard() }],
    },
    // 3. Bash path boundary (file-modifying commands stay in worktree)
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: bashPathBoundary() }],
    },
    // 4. Write/Edit path boundary
    {
      matcher: "Write",
      hooks: [{ type: "command", command: writeEditPathBoundary() }],
    },
    {
      matcher: "Edit",
      hooks: [{ type: "command", command: writeEditPathBoundary() }],
    },
  ];

  return { hooks: { PreToolUse: hooks } };
}

// ---------------------------------------------------------------------------
// Overlay generation (CLAUDE.md for the worktree)
// ---------------------------------------------------------------------------

/** Expand ~ to $HOME in a path */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

/** Read CLAUDE.md from a repo path, returning its contents or empty string */
function readClaudeMd(repoPath: string): string {
  const expanded = expandHome(repoPath);
  const claudeMdPath = join(expanded, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      return readFileSync(claudeMdPath, "utf-8");
    } catch {
      return "";
    }
  }
  return "";
}

/** Get strategy instructions based on strategy type */
function strategyInstructions(strategy: string | null, strategyConfig: string | null): string {
  switch (strategy || "solo") {
    case "solo":
      return "You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.";
    case "team": {
      let instructions = "You are one worker in a team. Focus only on your assigned scope. Do not modify files outside your area. Coordinate via commit messages.";
      if (strategyConfig) instructions += `\nScope: ${strategyConfig}`;
      return instructions;
    }
    case "sweep": {
      let instructions = "This is a sweep task — apply the same change across multiple files or modules. Be thorough and consistent. Check every occurrence.";
      if (strategyConfig) instructions += `\nPattern: ${strategyConfig}`;
      return instructions;
    }
    case "pipeline":
      return "This is a pipeline task — complete your stage, then hand off to the next. Document your output clearly.";
    default:
      return "You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.";
  }
}

/**
 * Build the overlay CLAUDE.md content for a worker's worktree.
 * Contains full task context, strategy instructions, repo CLAUDE.md, and quality gates.
 */
export function buildOverlay(taskId: string, db: Database): string {
  const task = db.taskGet(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const { title, repo, description, source_type, source_ref, strategy, strategy_config, branch, session_summary, files_modified, next_steps } = task;

  // Read CLAUDE.md from repo
  let claudeMdContent = "";
  if (repo) {
    const repoRow = db.repoGet(repo);
    if (repoRow?.local_path) claudeMdContent = readClaudeMd(repoRow.local_path);
  }

  // Source info
  let sourceInfo = "";
  if (source_ref) {
    switch (source_type) {
      case "github_issue": sourceInfo = `GitHub Issue: ${source_ref}`; break;
      case "github_pr": sourceInfo = `GitHub PR: ${source_ref}`; break;
      default: sourceInfo = `Source: ${source_ref}`; break;
    }
  }

  const strategyText = strategyInstructions(strategy, strategy_config);

  const parts: string[] = [];

  parts.push(`# Task: ${taskId}`);
  parts.push(`## ${title}`);
  parts.push("");

  if (description) {
    parts.push("### Description");
    parts.push(description);
    parts.push("");
  }

  if (sourceInfo) {
    parts.push("### Source");
    parts.push(sourceInfo);
    parts.push("");
  }

  parts.push("### Strategy");
  parts.push(strategyText);
  parts.push("");

  if (branch) {
    parts.push("### Git Branch");
    parts.push(`Work on branch: \`${branch}\``);
    parts.push(`Commit message format: \`grove(${taskId}): description of change\``);
    parts.push("");
  }

  if (session_summary) {
    parts.push("### Previous Session");
    parts.push(session_summary);
    parts.push("");
  }

  if (files_modified) {
    parts.push("### Files Already Modified");
    parts.push(files_modified);
    parts.push("");
  }

  if (next_steps) {
    parts.push("### Next Steps from Previous Session");
    parts.push(next_steps);
    parts.push("");
  }

  if (claudeMdContent) {
    parts.push("### Repository Context (from CLAUDE.md)");
    parts.push(claudeMdContent);
    parts.push("");
  }

  parts.push("### Session Summary Instructions");
  parts.push("Before finishing your session, create or update `.grove/session-summary.md` in the worktree with:");
  parts.push("- **Summary**: What you accomplished");
  parts.push("- **Files Modified**: List of files changed");
  parts.push("- **Next Steps**: What remains to be done (if anything)");
  parts.push("- **Blockers**: Any issues encountered");
  parts.push("");
  parts.push("This file is read by Grove to maintain continuity across sessions.");
  parts.push("");

  parts.push("### Working Guidelines");
  if (branch) {
    parts.push(`- Create or switch to branch: \`${branch}\``);
    parts.push(`- Make atomic commits with the format: \`grove(${taskId}): description\``);
  }
  parts.push("- Run tests if available before marking done");
  parts.push("- Write the session summary file before finishing");
  parts.push("- Do NOT push to remote — Grove handles that via `grove done`");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Sandbox deployment
// ---------------------------------------------------------------------------

/**
 * Deploy the sandbox into a worktree:
 * - Creates {worktreePath}/.claude/ directory
 * - Writes settings.local.json with guard hooks (merges with existing if present)
 * - Writes CLAUDE.md with full task overlay
 */
export function deploySandbox(worktreePath: string, taskId: string, db: Database): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // -- settings.local.json (guard hooks) --
  const settingsPath = join(claudeDir, "settings.local.json");
  const sandboxConfig = buildGuardHooks(taskId, worktreePath);

  let finalSettings: any = {};

  // Preserve existing settings if present
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      finalSettings = { ...existing };

      // Merge hooks: keep non-Grove hooks, replace Grove hooks with fresh ones
      if (existing.hooks?.PreToolUse) {
        const nonGroveHooks = existing.hooks.PreToolUse.filter(
          (h: any) => !h.hooks?.some?.((hook: any) => hook.command?.includes("GROVE_TASK_ID")),
        );
        finalSettings.hooks = {
          ...existing.hooks,
          PreToolUse: [...nonGroveHooks, ...sandboxConfig.hooks.PreToolUse],
        };
      } else {
        finalSettings.hooks = {
          ...(existing.hooks || {}),
          ...sandboxConfig.hooks,
        };
      }
    } catch {
      // Existing file is invalid JSON — overwrite
      finalSettings = sandboxConfig;
    }
  } else {
    finalSettings = sandboxConfig;
  }

  writeFileSync(settingsPath, JSON.stringify(finalSettings, null, 2) + "\n");

  // -- CLAUDE.md (task overlay) --
  const overlayPath = join(claudeDir, "CLAUDE.md");
  const overlayContent = buildOverlay(taskId, db);
  writeFileSync(overlayPath, overlayContent + "\n");
}

// ---------------------------------------------------------------------------
// Trigger prompts (short -p arguments that reference the overlay)
// ---------------------------------------------------------------------------

/**
 * Short trigger prompt for new tasks.
 * The full context lives in .claude/CLAUDE.md — this just kicks off execution.
 */
export function buildTriggerPrompt(taskId: string): string {
  return `Execute the task described in your CLAUDE.md instructions. Task ID: ${taskId}. Follow all working guidelines, strategy instructions, and quality gates in that file. Write a session summary before finishing.`;
}

/**
 * Short trigger prompt for resumed tasks.
 * References the session context already in the overlay.
 */
export function buildResumeTriggerPrompt(taskId: string): string {
  return `Resume the task described in your CLAUDE.md instructions. Task ID: ${taskId}. Your CLAUDE.md contains the previous session summary, files modified, and next steps. Continue from where the last session left off. Write an updated session summary before finishing.`;
}
