import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createFixtureRepo } from "../fixtures/helpers";
import { rebaseOnMain } from "../../src/shared/worktree";

function gitInDir(dir: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return r.stdout.toString().trim();
}

describe("rebaseOnMain", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  function setupRepoWithWorktree(): {
    repoPath: string;
    worktreePath: string;
    cleanup: () => void;
  } {
    // Create a "remote" bare repo to act as origin
    const { repoPath: originPath, cleanup: cleanupOrigin } = createFixtureRepo();
    const barePath = originPath + "-bare";
    Bun.spawnSync(["git", "clone", "--bare", originPath, barePath]);

    // Clone from bare to create "local" repo
    const localPath = originPath + "-local";
    Bun.spawnSync(["git", "clone", barePath, localPath]);
    Bun.spawnSync(["git", "-C", localPath, "config", "user.email", "test@grove.dev"]);
    Bun.spawnSync(["git", "-C", localPath, "config", "user.name", "Grove Test"]);

    // Create worktree on a feature branch
    const worktreeDir = join(localPath, ".grove", "worktrees");
    mkdirSync(worktreeDir, { recursive: true });
    const worktreePath = join(worktreeDir, "T-001");
    Bun.spawnSync(["git", "-C", localPath, "worktree", "add", "-b", "grove/T-001-test", worktreePath, "origin/main"]);
    Bun.spawnSync(["git", "-C", worktreePath, "config", "user.email", "test@grove.dev"]);
    Bun.spawnSync(["git", "-C", worktreePath, "config", "user.name", "Grove Test"]);

    // Make a commit on the worktree branch
    writeFileSync(join(worktreePath, "feature.txt"), "feature work\n");
    Bun.spawnSync(["git", "-C", worktreePath, "add", "."]);
    Bun.spawnSync(["git", "-C", worktreePath, "commit", "-m", "Add feature"]);

    // Simulate another task merging to main: push a new commit to origin/main
    const pusherPath = originPath + "-pusher";
    Bun.spawnSync(["git", "clone", barePath, pusherPath]);
    Bun.spawnSync(["git", "-C", pusherPath, "config", "user.email", "other@grove.dev"]);
    Bun.spawnSync(["git", "-C", pusherPath, "config", "user.name", "Other Dev"]);
    writeFileSync(join(pusherPath, "other-task.txt"), "other task work\n");
    Bun.spawnSync(["git", "-C", pusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", pusherPath, "commit", "-m", "Other task merged"]);
    Bun.spawnSync(["git", "-C", pusherPath, "push", "origin", "main"]);

    const cleanup = () => {
      Bun.spawnSync(["git", "-C", localPath, "worktree", "remove", worktreePath, "--force"]);
      cleanupOrigin();
      for (const p of [barePath, localPath, pusherPath]) {
        Bun.spawnSync(["rm", "-rf", p]);
      }
    };
    cleanups.push(cleanup);

    return { repoPath: localPath, worktreePath, cleanup };
  }

  test("clean rebase succeeds and includes upstream changes", () => {
    const { worktreePath } = setupRepoWithWorktree();

    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toBeUndefined();

    // Verify the worktree has the upstream commit
    const log = gitInDir(worktreePath, ["log", "--oneline"]);
    expect(log).toContain("Other task merged");
    expect(log).toContain("Add feature");
  });

  test("returns conflict info when rebase has conflicts", () => {
    const { repoPath, worktreePath } = setupRepoWithWorktree();

    // Push a conflicting change to origin/main
    const barePath = repoPath.replace("-local", "") + "-bare";
    const conflictPusherPath = repoPath + "-conflict-pusher";
    Bun.spawnSync(["git", "clone", barePath, conflictPusherPath]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "config", "user.email", "conflict@grove.dev"]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "config", "user.name", "Conflict Dev"]);
    writeFileSync(join(conflictPusherPath, "README.md"), "# Conflicting change\n");
    Bun.spawnSync(["git", "-C", conflictPusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "commit", "-m", "Conflict on README"]);
    Bun.spawnSync(["git", "-C", conflictPusherPath, "push", "origin", "main"]);
    cleanups.push(() => Bun.spawnSync(["rm", "-rf", conflictPusherPath]));

    // Modify the same file in the worktree
    writeFileSync(join(worktreePath, "README.md"), "# My conflicting change\n");
    Bun.spawnSync(["git", "-C", worktreePath, "add", "."]);
    Bun.spawnSync(["git", "-C", worktreePath, "commit", "-m", "Conflicting README change"]);

    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(false);
    expect(result.conflictFiles).toBeDefined();
    expect(result.conflictFiles!.length).toBeGreaterThan(0);
    expect(result.conflictFiles).toContain("README.md");

    // Verify rebase was aborted (branch is clean)
    const status = gitInDir(worktreePath, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  test("respects custom defaultBranch parameter", () => {
    const { repoPath, worktreePath } = setupRepoWithWorktree();

    // Create a "develop" branch on origin with a unique commit
    const barePath = repoPath.replace("-local", "") + "-bare";
    const devPusherPath = repoPath + "-dev-pusher";
    Bun.spawnSync(["git", "clone", barePath, devPusherPath]);
    Bun.spawnSync(["git", "-C", devPusherPath, "config", "user.email", "dev@grove.dev"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "config", "user.name", "Dev Pusher"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "checkout", "-b", "develop"]);
    writeFileSync(join(devPusherPath, "develop-only.txt"), "develop branch content\n");
    Bun.spawnSync(["git", "-C", devPusherPath, "add", "."]);
    Bun.spawnSync(["git", "-C", devPusherPath, "commit", "-m", "Develop branch commit"]);
    Bun.spawnSync(["git", "-C", devPusherPath, "push", "origin", "develop"]);
    cleanups.push(() => Bun.spawnSync(["rm", "-rf", devPusherPath]));

    // Fetch in local so origin/develop exists
    Bun.spawnSync(["git", "-C", repoPath, "fetch", "origin"]);

    const result = rebaseOnMain(worktreePath, "develop");

    expect(result.ok).toBe(true);

    // Verify develop-only.txt is now in the worktree
    const log = gitInDir(worktreePath, ["log", "--oneline"]);
    expect(log).toContain("Develop branch commit");
  });

  test("no-op when already up to date", () => {
    const { worktreePath } = setupRepoWithWorktree();

    // First rebase to get up to date
    rebaseOnMain(worktreePath);

    // Second rebase should be a no-op success
    const result = rebaseOnMain(worktreePath);

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toBeUndefined();
  });
});
