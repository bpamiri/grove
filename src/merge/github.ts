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
  base?: string;
  draft?: boolean;
}): { number: number; url: string } {
  const args = [
    "pr", "create", "-R", repo,
    "--title", opts.title,
    "--body", opts.body,
    "--head", opts.head,
  ];
  if (opts.base) args.push("--base", opts.base);
  if (opts.draft) args.push("--draft");

  const result = gh(args);
  if (!result.ok) {
    throw new Error(`gh pr create failed: ${result.stderr}`);
  }
  // gh pr create outputs the PR URL to stdout (e.g. https://github.com/owner/repo/pull/123)
  const url = result.stdout.trim();
  const prNumberMatch = url.match(/\/pull\/(\d+)/);
  const number = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;
  return { number, url };
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

export function ghPrChecks(repo: string, prNumber: number): PrCheckStatus {
  const result = gh(["pr", "checks", String(prNumber), "-R", repo, "--json", "name,state"]);
  if (!result.ok) {
    return { state: "pending", total: 0, passing: 0, failing: 0, pending: 0 };
  }

  const checks = JSON.parse(result.stdout || "[]") as Array<{ name: string; state: string }>;
  const total = checks.length;
  const passing = checks.filter(c => c.state === "SUCCESS").length;
  const failing = checks.filter(c => c.state === "FAILURE").length;
  const pending = total - passing - failing;

  let state: "pending" | "success" | "failure" = "pending";
  if (failing > 0) state = "failure";
  else if (pending === 0 && total > 0) state = "success";

  return { state, total, passing, failing, pending };
}

export interface PrCheckDetail {
  name: string;
  conclusion: string;
  link: string;
}

/** Get details of failed CI checks on a PR */
export function ghPrCheckDetails(repo: string, prNumber: number): PrCheckDetail[] {
  const result = gh(["pr", "checks", String(prNumber), "-R", repo]);
  if (!result.ok || !result.stdout) return [];
  // Output format: name\tstate\tduration\tlink (tab-separated)
  const failures: PrCheckDetail[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 2 && parts[1] === "fail") {
      failures.push({
        name: parts[0].trim(),
        conclusion: "failure",
        link: parts[3]?.trim() ?? "",
      });
    }
  }
  return failures;
}

/** Update a PR title */
export function ghPrEditTitle(repo: string, prNumber: number, title: string): boolean {
  const result = gh(["pr", "edit", String(prNumber), "-R", repo, "--title", title]);
  return result.ok;
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
// Issue operations
// ---------------------------------------------------------------------------

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  body: string;
  labels: Array<{ name: string }>;
}

export function ghIssueCreate(repo: string, opts: {
  title: string;
  body: string;
}): { number: number; url: string } {
  const args = [
    "issue", "create", "-R", repo,
    "--title", opts.title,
    "--body", opts.body,
  ];
  const result = gh(args);
  if (!result.ok) {
    throw new Error(`gh issue create failed: ${result.stderr}`);
  }
  const url = result.stdout.trim();
  const issueNumberMatch = url.match(/\/issues\/(\d+)/);
  const number = issueNumberMatch ? parseInt(issueNumberMatch[1], 10) : 0;
  return { number, url };
}

export function ghIssueClose(repo: string, issueNumber: number): boolean {
  const result = gh(["issue", "close", String(issueNumber), "-R", repo]);
  return result.ok;
}

export function ghIssueList(repo: string, opts?: { state?: string; limit?: number }): GhIssue[] {
  const args = [
    "issue", "list", "-R", repo,
    "--json", "number,title,state,url,body,labels",
  ];
  if (opts?.state) args.push("--state", opts.state);
  args.push("--limit", String(opts?.limit ?? 30));
  return ghJson<GhIssue[]>(args);
}

// ---------------------------------------------------------------------------
// Git push & branch cleanup
// ---------------------------------------------------------------------------

export function gitPush(repoPath: string, branch: string): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", repoPath, "push", "-u", "origin", branch]);
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr.toString().trim(),
  };
}

/** Delete a branch locally and on the remote (best-effort, won't throw) */
export function gitDeleteBranch(repoPath: string, branch: string): { localOk: boolean; remoteOk: boolean } {
  const local = Bun.spawnSync(["git", "-C", repoPath, "branch", "-D", branch]);
  const remote = Bun.spawnSync(["git", "-C", repoPath, "push", "origin", "--delete", branch]);
  return {
    localOk: local.exitCode === 0,
    remoteOk: remote.exitCode === 0,
  };
}

// ---------------------------------------------------------------------------
// Merge-state helpers (pure functions, easy to unit-test)
// ---------------------------------------------------------------------------

/** Resolve an array of CI check objects into an aggregate status */
export function resolveCheckState(checks: Array<{ name: string; state: string; conclusion?: string }>): PrCheckStatus {
  const total = checks.length;
  if (total === 0) return { state: "success", total: 0, passing: 0, failing: 0, pending: 0 };

  const passing = checks.filter(c => c.state === "COMPLETED" && c.conclusion === "SUCCESS").length;
  const failing = checks.filter(c => c.state === "COMPLETED" && c.conclusion === "FAILURE").length;
  const pending = total - passing - failing;

  let state: "pending" | "success" | "failure" = "pending";
  if (failing > 0) state = "failure";
  else if (pending === 0) state = "success";

  return { state, total, passing, failing, pending };
}

/** Normalize a GitHub mergeable state string */
export function resolveMergeableState(raw: string): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  const upper = raw.toUpperCase();
  if (upper === "MERGEABLE") return "MERGEABLE";
  if (upper === "CONFLICTING") return "CONFLICTING";
  return "UNKNOWN";
}

/** Lockfile patterns considered trivial merge conflicts */
export const TRIVIAL_CONFLICT_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Gemfile.lock",
  "Cargo.lock",
  "composer.lock",
  "poetry.lock",
];

/** Check if a conflicting file is a trivial lockfile conflict */
export function isTrivialConflict(filePath: string): boolean {
  return TRIVIAL_CONFLICT_PATTERNS.some(pattern => {
    // Match exact filename or path ending with /filename
    const regex = new RegExp(`(^|/)${pattern.replace(".", "\\.")}$`);
    return regex.test(filePath);
  });
}
