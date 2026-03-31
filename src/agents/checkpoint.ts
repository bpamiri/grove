// Grove v3 — Worker checkpointing: WIP commit + state persistence
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Checkpoint {
  taskId: string;
  stepId: string;
  stepIndex: number;
  timestamp: string;
  commitSha: string | null;
  filesModified: string[];
  sessionSummary: string;
  nextAction: string;
  costSoFar: number;
  tokensSoFar: number;
}

interface CreateOpts {
  taskId: string;
  stepId: string;
  stepIndex: number;
  sessionSummary: string;
  costSoFar: number;
  tokensSoFar: number;
}

/** Commit any uncommitted changes as a WIP checkpoint. Returns SHA or null if nothing to commit. */
export function commitWip(worktreePath: string, taskId: string): string | null {
  // Check for changes
  const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktreePath });
  const hasChanges = statusResult.stdout.toString().trim().length > 0;
  if (!hasChanges) return null;

  // Stage and commit
  Bun.spawnSync(["git", "add", "-A"], { cwd: worktreePath });
  const commitResult = Bun.spawnSync(
    ["git", "commit", "-m", `grove: WIP checkpoint for ${taskId}`],
    { cwd: worktreePath },
  );
  if (commitResult.exitCode !== 0) return null;

  // Get SHA
  const shaResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktreePath });
  return shaResult.stdout.toString().trim() || null;
}

/** Create a checkpoint: commit WIP, get file list, write JSON. */
export function createCheckpoint(worktreePath: string, opts: CreateOpts): Checkpoint {
  const sha = commitWip(worktreePath, opts.taskId);

  // Get files modified
  const diffResult = Bun.spawnSync(["git", "diff", "--name-only", "HEAD~1..HEAD"], { cwd: worktreePath });
  const filesModified = diffResult.exitCode === 0
    ? diffResult.stdout.toString().trim().split("\n").filter(Boolean)
    : [];

  // Read session summary if worker wrote one
  const summaryPath = join(worktreePath, ".grove", "session-summary.md");
  const summary = existsSync(summaryPath)
    ? readFileSync(summaryPath, "utf-8")
    : opts.sessionSummary;

  const checkpoint: Checkpoint = {
    taskId: opts.taskId,
    stepId: opts.stepId,
    stepIndex: opts.stepIndex,
    timestamp: new Date().toISOString(),
    commitSha: sha,
    filesModified,
    sessionSummary: summary,
    nextAction: "",
    costSoFar: opts.costSoFar,
    tokensSoFar: opts.tokensSoFar,
  };

  // Write to worktree
  const checkpointPath = join(worktreePath, ".grove", "checkpoint.json");
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

  return checkpoint;
}

/** Load a checkpoint from the worktree. Returns null if none exists. */
export function loadCheckpoint(worktreePath: string): Checkpoint | null {
  const checkpointPath = join(worktreePath, ".grove", "checkpoint.json");
  if (!existsSync(checkpointPath)) return null;
  try {
    return JSON.parse(readFileSync(checkpointPath, "utf-8"));
  } catch {
    return null;
  }
}
