// Grove v2 — Wrapper for `gh` CLI calls
// All functions use Bun.spawnSync() for subprocess management.

/** Check if `gh` is available on PATH */
export function ghAvailable(): boolean {
  const result = Bun.spawnSync(["which", "gh"]);
  return result.exitCode === 0;
}

/** Run a gh command and return { exitCode, stdout, stderr } */
function gh(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["gh", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/** Run a gh command, parse JSON output. Throws on non-zero exit. */
function ghJson<T>(args: string[]): T {
  const result = gh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh command failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  if (!result.stdout) {
    return [] as unknown as T;
  }
  return JSON.parse(result.stdout) as T;
}

// ---------------------------------------------------------------------------
// Issue types
// ---------------------------------------------------------------------------

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GhIssueListOpts {
  state?: "open" | "closed" | "all";
  label?: string;
  limit?: number;
  assignee?: string;
}

/**
 * List issues for a repo.
 * @param repo — GitHub repo in "owner/name" format
 */
export function ghIssueList(repo: string, opts?: GhIssueListOpts): GhIssue[] {
  const args = ["issue", "list", "-R", repo, "--json", "number,title,state,body,labels,assignees,url,createdAt,updatedAt"];

  if (opts?.state) args.push("--state", opts.state);
  if (opts?.label) args.push("--label", opts.label);
  if (opts?.limit) args.push("--limit", String(opts.limit));
  if (opts?.assignee) args.push("--assignee", opts.assignee);

  return ghJson<GhIssue[]>(args);
}

// ---------------------------------------------------------------------------
// PR types
// ---------------------------------------------------------------------------

export interface GhPr {
  number: number;
  title: string;
  state: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  labels: { name: string }[];
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface GhPrListOpts {
  state?: "open" | "closed" | "merged" | "all";
  label?: string;
  limit?: number;
  head?: string;
  base?: string;
}

/**
 * List pull requests for a repo.
 * @param repo — GitHub repo in "owner/name" format
 */
export function ghPrList(repo: string, opts?: GhPrListOpts): GhPr[] {
  const args = [
    "pr", "list", "-R", repo,
    "--json", "number,title,state,body,headRefName,baseRefName,url,isDraft,mergeable,labels,author,createdAt,updatedAt,additions,deletions,changedFiles",
  ];

  if (opts?.state) args.push("--state", opts.state);
  if (opts?.label) args.push("--label", opts.label);
  if (opts?.limit) args.push("--limit", String(opts.limit));
  if (opts?.head) args.push("--head", opts.head);
  if (opts?.base) args.push("--base", opts.base);

  return ghJson<GhPr[]>(args);
}

/**
 * Get details for a specific PR.
 * @param repo — GitHub repo in "owner/name" format
 * @param prNumber — PR number
 */
export function ghPrView(repo: string, prNumber: number): GhPr {
  return ghJson<GhPr>([
    "pr", "view", String(prNumber), "-R", repo,
    "--json", "number,title,state,body,headRefName,baseRefName,url,isDraft,mergeable,labels,author,createdAt,updatedAt,additions,deletions,changedFiles",
  ]);
}

/**
 * Get the diff for a PR.
 * @param repo — GitHub repo in "owner/name" format
 * @param prNumber — PR number
 * @returns The diff as a string
 */
export function ghPrDiff(repo: string, prNumber: number): string {
  const result = gh(["pr", "diff", String(prNumber), "-R", repo]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr diff failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Merge a PR.
 * @param repo — GitHub repo in "owner/name" format
 * @param prNumber — PR number
 */
export function ghPrMerge(repo: string, prNumber: number): void {
  const result = gh(["pr", "merge", String(prNumber), "-R", repo, "--merge"]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr merge failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

/**
 * Close a PR without merging.
 * @param repo — GitHub repo in "owner/name" format
 * @param prNumber — PR number
 */
export function ghPrClose(repo: string, prNumber: number): void {
  const result = gh(["pr", "close", String(prNumber), "-R", repo]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr close failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

/**
 * Create a pull request.
 * @param repo — GitHub repo in "owner/name" format
 * @returns PR number and URL
 */
export function ghPrCreate(repo: string, opts: {
  title: string;
  body: string;
  head: string;
  draft?: boolean;
}): { number: number; url: string } {
  const args = [
    "pr", "create",
    "-R", repo,
    "--title", opts.title,
    "--body", opts.body,
    "--head", opts.head,
  ];
  if (opts.draft) args.push("--draft");

  const result = gh([...args, "--json", "number,url"]);
  if (result.exitCode !== 0) {
    throw new Error(`gh pr create failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as { number: number; url: string };
}
