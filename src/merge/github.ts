// Grove v3 — gh CLI wrapper
// All functions use Bun.spawnSync for subprocess management.

function gh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["gh", ...args]);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function ghJson<T>(args: string[]): T {
  const result = gh(args);
  if (!result.ok) {
    throw new Error(`gh failed: ${result.stderr}`);
  }
  if (!result.stdout) return [] as unknown as T;
  return JSON.parse(result.stdout) as T;
}

export function ghAvailable(): boolean {
  return Bun.spawnSync(["which", "gh"]).exitCode === 0;
}

// ---------------------------------------------------------------------------
// PR operations
// ---------------------------------------------------------------------------

export interface GhPr {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function ghPrCreate(repo: string, opts: {
  title: string;
  body: string;
  head: string;
  draft?: boolean;
}): { number: number; url: string } {
  const args = [
    "pr", "create", "-R", repo,
    "--title", opts.title,
    "--body", opts.body,
    "--head", opts.head,
  ];
  if (opts.draft) args.push("--draft");

  const result = gh([...args, "--json", "number,url"]);
  if (!result.ok) {
    throw new Error(`gh pr create failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as { number: number; url: string };
}

export function ghPrMerge(repo: string, prNumber: number): void {
  const result = gh(["pr", "merge", String(prNumber), "-R", repo, "--merge"]);
  if (!result.ok) {
    throw new Error(`gh pr merge failed: ${result.stderr}`);
  }
}

export interface PrCheckStatus {
  state: "pending" | "success" | "failure";
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

/** Pure logic: resolve check state from an array of check results */
export function resolveCheckState(
  checks: Array<{ name: string; state: string; conclusion: string }>,
): PrCheckStatus {
  const total = checks.length;
  const passing = checks.filter(c => c.conclusion === "SUCCESS" || c.conclusion === "success").length;
  const failing = checks.filter(c => c.conclusion === "FAILURE" || c.conclusion === "failure").length;
  const pending = total - passing - failing;

  let state: "pending" | "success" | "failure" = "pending";
  if (failing > 0) state = "failure";
  else if (pending === 0) state = "success";

  return { state, total, passing, failing, pending };
}

export function ghPrChecks(repo: string, prNumber: number): PrCheckStatus {
  const result = gh(["pr", "checks", String(prNumber), "-R", repo, "--json", "name,state,conclusion"]);
  if (!result.ok) {
    return { state: "pending", total: 0, passing: 0, failing: 0, pending: 0 };
  }

  const checks = JSON.parse(result.stdout || "[]") as Array<{ name: string; state: string; conclusion: string }>;
  return resolveCheckState(checks);
}

export function ghPrList(repo: string, opts?: { head?: string; state?: string; limit?: number }): GhPr[] {
  const args = [
    "pr", "list", "-R", repo,
    "--json", "number,title,state,url,headRefName,mergeable,additions,deletions,changedFiles",
  ];
  if (opts?.head) args.push("--head", opts.head);
  if (opts?.state) args.push("--state", opts.state);
  if (opts?.limit) args.push("--limit", String(opts.limit));
  return ghJson<GhPr[]>(args);
}

// ---------------------------------------------------------------------------
// Mergeable state
// ---------------------------------------------------------------------------

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Pure logic: resolve GitHub's mergeable field to a typed state */
export function resolveMergeableState(mergeable: string): MergeableState {
  const upper = mergeable?.toUpperCase();
  if (upper === "MERGEABLE") return "MERGEABLE";
  if (upper === "CONFLICTING") return "CONFLICTING";
  return "UNKNOWN";
}

/** Fetch the mergeable status of a PR */
export function ghPrMergeable(repo: string, prNumber: number): MergeableState {
  const result = gh(["pr", "view", String(prNumber), "-R", repo, "--json", "mergeable"]);
  if (!result.ok) return "UNKNOWN";
  try {
    const parsed = JSON.parse(result.stdout) as { mergeable?: string };
    return resolveMergeableState(parsed.mergeable ?? "");
  } catch {
    return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// Git push / rebase
// ---------------------------------------------------------------------------

export function gitPush(repoPath: string, branch: string): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", repoPath, "push", "-u", "origin", branch]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr.toString().trim(),
  };
}

/** Force-push with lease (safe for rebased branches) */
export function gitPushForce(repoPath: string, branch: string): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", repoPath, "push", "--force-with-lease", "origin", branch]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr.toString().trim(),
  };
}

/** Fetch from origin and rebase onto base branch. Aborts rebase on failure. */
export function gitRebase(repoPath: string, baseBranch: string): { ok: boolean; stderr: string } {
  const fetch = Bun.spawnSync(["git", "-C", repoPath, "fetch", "origin"]);
  if (fetch.exitCode !== 0) {
    return { ok: false, stderr: fetch.stderr.toString().trim() };
  }

  const rebase = Bun.spawnSync(["git", "-C", repoPath, "rebase", `origin/${baseBranch}`]);
  if (rebase.exitCode !== 0) {
    // Abort the failed rebase to leave worktree clean
    Bun.spawnSync(["git", "-C", repoPath, "rebase", "--abort"]);
    return { ok: false, stderr: rebase.stderr.toString().trim() };
  }

  return { ok: true, stderr: "" };
}
