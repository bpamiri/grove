/** Parse org/repo from a GitHub remote URL. Returns null if not a GitHub URL. */
export function parseGithubRemote(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/);
  return match ? match[1] : null;
}

/** Run `git remote get-url origin` at the given path and parse the GitHub org/repo. */
export function detectGithubRemote(path: string): string | null {
  const result = Bun.spawnSync(["git", "-C", path, "remote", "get-url", "origin"]);
  if (result.exitCode !== 0) return null;
  return parseGithubRemote(result.stdout.toString().trim());
}
