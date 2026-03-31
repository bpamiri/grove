// Grove v3 — Git worktree management for tasks
// Each task gets an isolated worktree under {tree_path}/.grove/worktrees/{task_id}
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Database } from "../broker/db";
import { expandTilde, realPath } from "./platform";

/** Expand ~ to home directory */
export function expandHome(p: string): string {
  return expandTilde(p);
}

/** Convert a title to a URL-safe slug */
export function slugify(text: string, maxLen: number = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

/** Resolve the default branch for a repo (origin/develop, origin/main, etc.) */
function resolveDefaultBranch(repoPath: string, configured?: string): string {
  if (configured) {
    // Try origin/<configured> first, then bare name
    for (const ref of [`origin/${configured}`, configured]) {
      const check = Bun.spawnSync(["git", "-C", repoPath, "rev-parse", "--verify", ref], { stderr: "pipe" });
      if (check.exitCode === 0) return ref;
    }
  }
  // Auto-detect: check origin/HEAD, then common names
  const head = Bun.spawnSync(["git", "-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"], { stderr: "pipe" });
  if (head.exitCode === 0) {
    const ref = head.stdout.toString().trim().replace("refs/remotes/", "");
    if (ref) return ref;
  }
  for (const ref of ["origin/develop", "origin/main", "origin/master"]) {
    const check = Bun.spawnSync(["git", "-C", repoPath, "rev-parse", "--verify", ref], { stderr: "pipe" });
    if (check.exitCode === 0) return ref;
  }
  return "origin/main";
}

/** Run a git command, return { ok, stdout, stderr } */
function git(repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", repoPath, ...args]);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/**
 * Create a git worktree for a task.
 * Returns the worktree path.
 * Location: {tree_path}/.grove/worktrees/{task_id}
 * Branch: {branch_prefix}{task_id}-{slug}
 */
export function createWorktree(
  taskId: string,
  treePath: string,
  branchPrefix: string,
  title: string,
  defaultBranch?: string,
): string {
  const repoPath = expandHome(treePath);

  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const slug = slugify(title);
  const branch = `${branchPrefix}${taskId}-${slug}`;
  const worktreeDir = join(repoPath, ".grove", "worktrees");
  const worktreePath = join(worktreeDir, taskId);

  mkdirSync(worktreeDir, { recursive: true });

  // If worktree already exists, return it
  if (existsSync(worktreePath)) {
    return worktreePath;
  }

  // Resolve the start point: configured default_branch, or auto-detect
  const startPoint = resolveDefaultBranch(repoPath, defaultBranch);

  // Fetch latest from origin to ensure we branch from up-to-date ref
  git(repoPath, ["fetch", "origin", startPoint.replace("origin/", "")]);

  // Check if branch already exists
  const branchExists = git(repoPath, ["rev-parse", "--verify", branch]).ok;

  const result = branchExists
    ? git(repoPath, ["worktree", "add", worktreePath, branch])
    : git(repoPath, ["worktree", "add", "-b", branch, worktreePath, startPoint]);

  if (!result.ok) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  // Create artifact directories
  mkdirSync(join(worktreePath, ".grove"), { recursive: true });
  mkdirSync(join(worktreePath, ".claude"), { recursive: true });

  return worktreePath;
}

/** Remove a worktree via git and prune refs */
export function cleanupWorktree(taskId: string, treePath: string): void {
  const repoPath = expandHome(treePath);
  const worktreePath = join(repoPath, ".grove", "worktrees", taskId);

  if (!existsSync(worktreePath)) return;

  git(repoPath, ["worktree", "remove", worktreePath, "--force"]);
  git(repoPath, ["worktree", "prune"]);
}

/** Check if a worktree exists on disk */
export function worktreeExists(taskId: string, treePath: string): boolean {
  const worktreePath = join(expandHome(treePath), ".grove", "worktrees", taskId);
  return existsSync(worktreePath);
}

/** Worktree listing entry */
export interface WorktreeEntry {
  taskId: string;
  branch: string;
  path: string;
}

/** List all grove worktrees for a tree/repo */
export function listWorktrees(treePath: string): WorktreeEntry[] {
  const repoPath = expandHome(treePath);
  if (!existsSync(join(repoPath, ".git"))) return [];

  // Resolve real path for consistent comparison
  const resolvedPath = realPath(repoPath);
  const groveDir = join(resolvedPath, ".grove", "worktrees");

  const result = git(repoPath, ["worktree", "list", "--porcelain"]);
  if (!result.ok || !result.stdout) return [];

  const entries: WorktreeEntry[] = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      currentBranch = "";
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      if (currentPath && currentBranch && currentPath.startsWith(groveDir + "/")) {
        entries.push({
          taskId: basename(currentPath),
          branch: currentBranch,
          path: currentPath,
        });
      }
      currentPath = "";
      currentBranch = "";
    }
  }

  // Flush last entry
  if (currentPath && currentBranch && currentPath.startsWith(groveDir + "/")) {
    entries.push({ taskId: basename(currentPath), branch: currentBranch, path: currentPath });
  }

  return entries;
}

/** Get the branch name for a task */
export function branchName(taskId: string, title: string, branchPrefix: string): string {
  return `${branchPrefix}${taskId}-${slugify(title)}`;
}

/** Result of a single worktree prune */
export interface PrunedEntry {
  taskId: string;
  treeId: string;
  reason: "completed" | "failed" | "orphaned";
}

/** Result of pruning all stale worktrees */
export interface PruneResult {
  pruned: PrunedEntry[];
  errors: string[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const KEEP_STATUSES = new Set(["active", "queued", "draft", "paused"]);

/**
 * Scan all trees for stale worktrees and remove them.
 * A worktree is stale if its task is completed, failed, or missing from the DB.
 */
export function pruneStaleWorktrees(db: Database): PruneResult {
  const pruned: PrunedEntry[] = [];
  const errors: string[] = [];

  const trees = db.allTrees();

  for (const tree of trees) {
    const treePath = expandHome(tree.path);
    const worktreeDir = join(treePath, ".grove", "worktrees");

    if (!existsSync(worktreeDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(worktreeDir) as string[];
    } catch {
      continue;
    }

    for (const taskId of entries) {
      const taskPath = join(worktreeDir, taskId);
      try {
        if (!statSync(taskPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const task = db.taskGet(taskId);

      let reason: PrunedEntry["reason"] | null = null;
      if (!task) {
        reason = "orphaned";
      } else if (TERMINAL_STATUSES.has(task.status)) {
        reason = task.status as "completed" | "failed";
      } else if (KEEP_STATUSES.has(task.status)) {
        continue;
      } else {
        continue;
      }

      try {
        cleanupWorktree(taskId, tree.path);
        pruned.push({ taskId, treeId: tree.id, reason: reason! });
      } catch (err: any) {
        errors.push(`${taskId}: ${err.message}`);
      }
    }
  }

  return { pruned, errors };
}
