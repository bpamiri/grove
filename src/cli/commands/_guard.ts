// Grove v3 — Guard subcommand: sandbox enforcement for worker/reviewer agents.
// Invoked as PreToolUse hooks: grove _guard <check-type> <worktree-path>
// Reads CLAUDE_TOOL_INPUT from env, parses JSON, validates.
// Exit 0 = allow, exit 2 = block.
import { resolve, sep, join } from "node:path";
import { tempDir } from "../../shared/platform";

// ---------------------------------------------------------------------------
// Blocked patterns
// ---------------------------------------------------------------------------

const WORKER_BLOCKED_PATTERNS = [
  "git push", "git reset --hard", "rm -rf /", "sudo ",
];

const REVIEWER_BLOCKED_PATTERNS = [
  ...WORKER_BLOCKED_PATTERNS,
  "git add", "git commit", "git checkout", "git rebase",
  "git merge", "git cherry-pick", "git stash",
];

// ---------------------------------------------------------------------------
// Check result type
// ---------------------------------------------------------------------------

export interface GuardResult {
  blocked: boolean;
  reason?: string;
}

const ALLOW: GuardResult = { blocked: false };

function block(reason: string): GuardResult {
  return { blocked: true, reason };
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

export function checkBashDanger(input: any): GuardResult {
  if (!input || typeof input.command !== "string") return ALLOW;
  const cmd = input.command.toLowerCase();
  for (const pattern of WORKER_BLOCKED_PATTERNS) {
    if (cmd.includes(pattern.toLowerCase())) {
      return block(`${pattern} is not allowed in Grove workers`);
    }
  }
  return ALLOW;
}

export function checkEditBoundary(input: any, worktreePath: string): GuardResult {
  if (!input || typeof input.file_path !== "string") return ALLOW;
  const resolved = resolve(input.file_path);
  const wtResolved = resolve(worktreePath);
  if (resolved.startsWith(wtResolved + sep) || resolved === wtResolved) return ALLOW;
  const tmpResolved = resolve(tempDir());
  if (resolved.startsWith(tmpResolved + sep) || resolved === tmpResolved) return ALLOW;
  return block(`${input.file_path} is outside worktree`);
}

export function checkReviewWrite(input: any, worktreePath: string): GuardResult {
  if (!input || typeof input.file_path !== "string") return ALLOW;
  const resolved = resolve(input.file_path);
  const allowed = resolve(join(worktreePath, ".grove", "review-result.json"));
  if (resolved === allowed) return ALLOW;
  return block("Reviewer can only write to .grove/review-result.json");
}

export function checkReviewBash(input: any): GuardResult {
  if (!input || typeof input.command !== "string") return ALLOW;
  const cmd = input.command.toLowerCase();
  for (const pattern of REVIEWER_BLOCKED_PATTERNS) {
    if (cmd.includes(pattern.toLowerCase())) {
      return block(`${pattern} is not allowed for reviewers`);
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const CHECKS: Record<string, (input: any, worktreePath: string) => GuardResult> = {
  "bash-danger": (input, _wt) => checkBashDanger(input),
  "edit-boundary": (input, wt) => checkEditBoundary(input, wt),
  "review-write": (input, wt) => checkReviewWrite(input, wt),
  "review-bash": (input, _wt) => checkReviewBash(input),
};

export async function run(args: string[]): Promise<void> {
  const checkType = args[0];
  const worktreePath = args[1] || "";

  const checkFn = CHECKS[checkType];
  if (!checkFn) {
    console.error(`Unknown guard check: ${checkType}`);
    process.exit(1);
  }

  let input: any = {};
  try {
    const raw = process.env.CLAUDE_TOOL_INPUT;
    if (raw) input = JSON.parse(raw);
  } catch {
    // Malformed input — fail open (same as prior bash behavior)
    process.exit(0);
  }

  const result = checkFn(input, worktreePath);
  if (result.blocked) {
    console.error(`BLOCKED: ${result.reason}`);
    process.exit(2);
  }

  process.exit(0);
}
