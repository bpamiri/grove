// Grove v2 — Worker prompt generation
// Builds the system prompt sent to Claude Code worker sessions.
// NOTE: buildPrompt/buildResumePrompt are kept for backward compatibility.
// New callers should use the sandbox overlay system (src/lib/sandbox.ts):
//   buildOverlay() → writes full context to .claude/CLAUDE.md
//   buildTriggerPrompt() / buildResumeTriggerPrompt() → short -p argument
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../core/db";

/** Expand ~ to $HOME in a path */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

/**
 * Convert text to URL-safe slug for branch names.
 * Lowercase, alphanumeric + hyphens, no leading/trailing/double hyphens, max 50 chars.
 */
export function slugify(text: string): string {
  let slug = text.toLowerCase().trim();
  slug = slug.replace(/[^a-z0-9]+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  slug = slug.replace(/-{2,}/g, "-");
  slug = slug.slice(0, 50).replace(/-+$/, "");
  return slug;
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
      if (strategyConfig) {
        instructions += `\nScope: ${strategyConfig}`;
      }
      return instructions;
    }

    case "sweep": {
      let instructions = "This is a sweep task — apply the same change across multiple files or modules. Be thorough and consistent. Check every occurrence.";
      if (strategyConfig) {
        instructions += `\nPattern: ${strategyConfig}`;
      }
      return instructions;
    }

    case "pipeline":
      return "This is a pipeline task — complete your stage, then hand off to the next. Document your output clearly.";

    default:
      return "You are the sole worker on this task. Complete it end-to-end: implement, test, and commit.";
  }
}

/**
 * Build the full prompt for a new worker session.
 * Includes: task title/description, source info, strategy instructions,
 * git branch, CLAUDE.md content, and session summary instructions.
 */
export function buildPrompt(taskId: string, db: Database): string {
  const task = db.taskGet(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const { title, repo, description, source_type, source_ref, strategy, strategy_config, session_summary } = task;

  // Determine branch name
  let branch = task.branch;
  if (!branch && repo) {
    const slug = slugify(title);
    const repoRow = db.repoGet(repo);
    const branchPrefix = repoRow?.branch_prefix || "grove/";
    branch = `${branchPrefix}${taskId}-${slug}`;
  }

  // Read CLAUDE.md from repo
  let claudeMdContent = "";
  if (repo) {
    const repoRow = db.repoGet(repo);
    if (repoRow?.local_path) {
      claudeMdContent = readClaudeMd(repoRow.local_path);
    }
  }

  // Source info
  let sourceInfo = "";
  if (source_ref) {
    switch (source_type) {
      case "github_issue":
        sourceInfo = `GitHub Issue: ${source_ref}`;
        break;
      case "github_pr":
        sourceInfo = `GitHub PR: ${source_ref}`;
        break;
      default:
        sourceInfo = `Source: ${source_ref}`;
        break;
    }
  }

  // Strategy instructions
  const strategyText = strategyInstructions(strategy, strategy_config);

  // Build the prompt
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

  parts.push("### Git Branch");
  parts.push(`Work on branch: \`${branch}\``);
  parts.push(`Commit message format: \`grove(${taskId}): description of change\``);
  parts.push("");

  if (claudeMdContent) {
    parts.push("### Repository Context (from CLAUDE.md)");
    parts.push(claudeMdContent);
    parts.push("");
  }

  if (session_summary) {
    parts.push("### Previous Session");
    parts.push(session_summary);
    parts.push("");
  }

  parts.push("### Session Summary Instructions");
  parts.push("Before finishing your session, create a file at `.grove/session-summary.md` in the worktree with:");
  parts.push("- **Summary**: What you accomplished");
  parts.push("- **Files Modified**: List of files changed");
  parts.push("- **Next Steps**: What remains to be done (if anything)");
  parts.push("- **Blockers**: Any issues encountered");
  parts.push("");
  parts.push("This file is read by Grove to maintain continuity across sessions.");
  parts.push("");

  parts.push("### Working Guidelines");
  parts.push(`- Create a new git branch if it doesn't exist: \`${branch}\``);
  parts.push(`- Make atomic commits with the format: \`grove(${taskId}): description\``);
  parts.push("- Run tests if available before marking done");
  parts.push("- Write the session summary file before finishing");

  return parts.join("\n");
}

/**
 * Build a resume prompt with previous session context.
 * Includes: session_summary, files_modified, next_steps from previous run.
 */
export function buildResumePrompt(taskId: string, db: Database): string {
  const task = db.taskGet(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const { title, repo, session_summary, files_modified, next_steps, branch } = task;

  // Read CLAUDE.md from repo
  let claudeMdContent = "";
  if (repo) {
    const repoRow = db.repoGet(repo);
    if (repoRow?.local_path) {
      claudeMdContent = readClaudeMd(repoRow.local_path);
    }
  }

  const parts: string[] = [];

  parts.push(`# Resuming Task: ${taskId}`);
  parts.push(`## ${title}`);
  parts.push("");
  parts.push("You are resuming a previously paused task. Continue from where the last session left off.");
  parts.push("");

  parts.push("### Previous Session Summary");
  parts.push(session_summary || "No previous session summary available.");
  parts.push("");

  parts.push("### Files Already Modified");
  parts.push(files_modified || "No files recorded from previous session.");
  parts.push("");

  parts.push("### Next Steps");
  parts.push(next_steps || "No specific next steps recorded. Review the code and continue the task.");
  parts.push("");

  parts.push("### Git Branch");
  parts.push(`Continue on branch: \`${branch || "unknown"}\``);
  parts.push(`Commit message format: \`grove(${taskId}): description of change\``);
  parts.push("");

  if (claudeMdContent) {
    parts.push("### Repository Context (from CLAUDE.md)");
    parts.push(claudeMdContent);
    parts.push("");
  }

  parts.push("### Session Summary Instructions");
  parts.push("Before finishing your session, create or update `.grove/session-summary.md` in the worktree with:");
  parts.push("- **Summary**: What you accomplished (including previous + this session)");
  parts.push("- **Files Modified**: List of all files changed across sessions");
  parts.push("- **Next Steps**: What remains to be done (if anything)");
  parts.push("- **Blockers**: Any issues encountered");
  parts.push("");

  parts.push("### Working Guidelines");
  parts.push(`- You should already be on branch: \`${branch || "unknown"}\``);
  parts.push(`- Make atomic commits with the format: \`grove(${taskId}): description\``);
  parts.push("- Run tests if available before marking done");
  parts.push("- Write the session summary file before finishing");

  return parts.join("\n");
}
