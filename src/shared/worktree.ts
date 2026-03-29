// Grove v3 — Git worktree management for tasks
// Each task gets an isolated worktree under {tree_path}/.grove/worktrees/{task_id}
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Database } from "../broker/db";

/** Expand ~ to $HOME */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

/** Convert a title to a URL-safe slug */
export function slugify(text: string, maxLen: number = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
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

  // Check if branch already exists
  const branchExists = git(repoPath, ["rev-parse", "--verify", branch]).ok;

  const result = branchExists
    ? git(repoPath, ["worktree", "add", worktreePath, branch])
    : git(repoPath, ["worktree", "add", "-b", branch, worktreePath]);

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
  const resolveResult = Bun.spawnSync(["pwd", "-P"], { cwd: repoPath });
  const resolvedPath = resolveResult.stdout.toString().trim();
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
