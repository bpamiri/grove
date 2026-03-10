// Grove v2 — Git worktree management for tasks
// Each task gets an isolated worktree under {repo_path}/.grove/worktrees/{task_id}
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { Database } from "../core/db";
import * as ui from "../core/ui";
import { slugify } from "./prompt-builder";

/** Expand ~ to $HOME in a path */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

/** Run a git command in a repo directory, return { exitCode, stdout, stderr } */
function git(repoPath: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", repoPath, ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/**
 * Create a git worktree for a task. Returns the worktree path.
 * Sets the task's branch and worktree_path fields in the DB.
 * Worktree location: {repo_path}/.grove/worktrees/{task_id}
 * Branch name: {branch_prefix}{task_id}-{slug}
 */
export function createWorktree(taskId: string, repoName: string, db: Database): string {
  // Get repo local path
  const repo = db.repoGet(repoName);
  if (!repo) {
    ui.die(`Repo '${repoName}' not found in database.`);
  }

  const repoPath = expandHome(repo.local_path);

  // Verify it's a git repo
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    ui.die(`Not a git repository: ${repoPath}`);
  }

  // Build branch name
  const title = db.taskGetField(taskId, "title") as string;
  const slug = slugify(title);
  const branchPrefix = repo.branch_prefix || "grove/";
  const branch = `${branchPrefix}${taskId}-${slug}`;

  // Worktree destination
  const worktreeDir = join(repoPath, ".grove", "worktrees");
  const worktreePath = join(worktreeDir, taskId);

  // Create parent directory
  mkdirSync(worktreeDir, { recursive: true });

  // If worktree already exists, just update DB and return
  if (existsSync(worktreePath)) {
    ui.debug(`Worktree already exists: ${worktreePath}`);
    db.taskSet(taskId, "branch", branch);
    db.taskSet(taskId, "worktree_path", worktreePath);
    return worktreePath;
  }

  // Check if branch already exists (local)
  const branchCheck = git(repoPath, ["rev-parse", "--verify", branch]);
  const branchExists = branchCheck.exitCode === 0;

  // Create the worktree
  let result: { exitCode: number; stdout: string; stderr: string };
  if (branchExists) {
    result = git(repoPath, ["worktree", "add", worktreePath, branch]);
  } else {
    result = git(repoPath, ["worktree", "add", "-b", branch, worktreePath]);
  }

  if (result.exitCode !== 0) {
    ui.die(`Failed to create worktree at ${worktreePath}: ${result.stderr}`);
  }

  // Create .grove directory in worktree for session artifacts
  mkdirSync(join(worktreePath, ".grove"), { recursive: true });

  // Update task in DB
  db.taskSet(taskId, "branch", branch);
  db.taskSet(taskId, "worktree_path", worktreePath);

  ui.debug(`Worktree created: ${worktreePath} (branch: ${branch})`);
  return worktreePath;
}

/**
 * Check if a worktree exists for the task (DB record + directory on disk).
 */
export function worktreeExists(taskId: string, db: Database): boolean {
  const wtPath = db.taskGetField(taskId, "worktree_path") as string | null;
  if (!wtPath) return false;
  return existsSync(wtPath);
}

/**
 * Get the worktree path from DB. Returns null if not set.
 */
export function worktreePath(taskId: string, db: Database): string | null {
  return (db.taskGetField(taskId, "worktree_path") as string | null) || null;
}

/**
 * Remove a worktree via `git worktree remove --force`, prune, and clear DB field.
 * Does NOT delete the branch.
 */
export function cleanupWorktree(taskId: string, db: Database): void {
  const wtPath = db.taskGetField(taskId, "worktree_path") as string | null;
  const repoName = db.taskGetField(taskId, "repo") as string | null;

  if (!wtPath || !existsSync(wtPath)) {
    ui.debug(`No worktree to clean up for ${taskId}`);
    return;
  }

  if (!repoName) {
    ui.warn(`Repo not found for task ${taskId}, removing directory only`);
    // Fallback: remove directory directly
    Bun.spawnSync(["rm", "-rf", wtPath]);
    db.taskSet(taskId, "worktree_path", "");
    return;
  }

  const repo = db.repoGet(repoName);
  if (!repo) {
    ui.warn(`Repo path not found for ${repoName}, removing directory only`);
    Bun.spawnSync(["rm", "-rf", wtPath]);
    db.taskSet(taskId, "worktree_path", "");
    return;
  }

  const repoPath = expandHome(repo.local_path);

  // Remove via git
  git(repoPath, ["worktree", "remove", wtPath, "--force"]);

  // Prune stale worktree refs
  git(repoPath, ["worktree", "prune"]);

  // Clear from DB
  db.taskSet(taskId, "worktree_path", "");

  ui.debug(`Worktree cleaned up for ${taskId}`);
}

/** Entry in worktree list */
export interface WorktreeEntry {
  taskId: string;
  branch: string;
  path: string;
}

/**
 * List all grove worktrees for a repo.
 * Parses `git worktree list --porcelain` and filters to those under {repo}/.grove/worktrees/.
 */
export function listWorktrees(repoName: string, db: Database): WorktreeEntry[] {
  const repo = db.repoGet(repoName);
  if (!repo) {
    ui.die(`Repo '${repoName}' not found in database.`);
  }

  const repoPath = expandHome(repo.local_path);
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    ui.die(`Not a git repository: ${repoPath}`);
  }

  // Resolve to real path for consistent comparison (handles macOS /private symlink)
  const resolveResult = Bun.spawnSync(["pwd", "-P"], { cwd: repoPath });
  const resolvedRepoPath = resolveResult.stdout.toString().trim();
  const groveDir = join(resolvedRepoPath, ".grove", "worktrees");

  const result = git(repoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let currentPath = "";
  let currentBranch = "";

  const lines = result.stdout.split("\n");
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      currentBranch = "";
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      // End of entry — check if it's a grove worktree
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

  // Flush last entry (porcelain output may not end with blank line)
  if (currentPath && currentBranch && currentPath.startsWith(groveDir + "/")) {
    entries.push({
      taskId: basename(currentPath),
      branch: currentBranch,
      path: currentPath,
    });
  }

  return entries;
}
