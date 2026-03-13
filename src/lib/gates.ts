// Grove v2 — Worker quality gates
// Validates worker output between completion and PR publishing.
import type { GateConfig, GateResult, QualityGatesConfig } from "../types";
import { configGet, configRepoDetail } from "../core/config";
import { detectToolchain } from "./scanner";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_GATE_CONFIG: GateConfig = {
  commits: true,
  tests: true,
  lint: false,
  diff_size: true,
  min_diff_lines: 1,
  max_diff_lines: 5000,
  test_timeout: 60,
  lint_timeout: 30,
};

// ---------------------------------------------------------------------------
// Config resolution: defaults -> global -> per-repo
// ---------------------------------------------------------------------------

function stripUndefined(obj: QualityGatesConfig): Partial<GateConfig> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<GateConfig>;
}

export function resolveGateConfig(
  global?: QualityGatesConfig,
  repo?: QualityGatesConfig,
): GateConfig {
  return {
    ...DEFAULT_GATE_CONFIG,
    ...(global ? stripUndefined(global) : {}),
    ...(repo ? stripUndefined(repo) : {}),
  };
}

// ---------------------------------------------------------------------------
// Output capture helper
// ---------------------------------------------------------------------------

const OUTPUT_CAP = 5_000;

function capOutput(buf: Buffer): string {
  const str = buf.toString().trim();
  if (str.length > OUTPUT_CAP) return str.slice(0, OUTPUT_CAP) + "\n[... truncated]";
  return str;
}

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------

export function checkCommits(worktreePath: string): GateResult {
  const result = Bun.spawnSync(["git", "log", "main..HEAD", "--oneline"], {
    cwd: worktreePath,
    stdin: "ignore",
  });

  const stdout = result.stdout.toString().trim();
  const lines = stdout ? stdout.split("\n").filter(Boolean) : [];

  if (lines.length === 0) {
    return {
      gate: "commits",
      passed: false,
      tier: "hard",
      message: "No commits found",
    };
  }

  return {
    gate: "commits",
    passed: true,
    tier: "hard",
    message: `${lines.length} commit${lines.length === 1 ? "" : "s"} on branch`,
  };
}

export function checkTests(worktreePath: string, timeoutSec: number): GateResult {
  const toolchain = detectToolchain(worktreePath);

  let cmd: string[];
  if (toolchain.runtime === "bun") {
    cmd = ["bun", "test"];
  } else if (toolchain.runtime === "node") {
    cmd = ["npm", "test"];
  } else if (toolchain.runtime === "python") {
    cmd = ["pytest"];
  } else {
    return {
      gate: "tests",
      passed: true,
      tier: "hard",
      message: "No test runner detected -- skipped",
    };
  }

  const result = Bun.spawnSync(cmd, {
    cwd: worktreePath,
    timeout: timeoutSec * 1000,
    stdin: "ignore",
  });

  if (result.exitCode === 0) {
    return {
      gate: "tests",
      passed: true,
      tier: "hard",
      message: "Tests passed",
    };
  }

  const stderr = capOutput(result.stderr);
  const stdout = capOutput(result.stdout);
  const output = stderr.length > 0 ? stderr : stdout;

  return {
    gate: "tests",
    passed: false,
    tier: "hard",
    message: `Tests failed (exit ${result.exitCode})`,
    output: output || undefined,
  };
}

export function checkLint(worktreePath: string, timeoutSec: number): GateResult {
  const toolchain = detectToolchain(worktreePath);

  let cmd: string[];
  if (toolchain.lintTool === "eslint") {
    cmd = ["npx", "eslint", "."];
  } else if (toolchain.lintTool === "ruff") {
    cmd = ["ruff", "check", "."];
  } else {
    return {
      gate: "lint",
      passed: true,
      tier: "soft",
      message: "No linter detected -- skipped",
    };
  }

  const result = Bun.spawnSync(cmd, {
    cwd: worktreePath,
    timeout: timeoutSec * 1000,
    stdin: "ignore",
  });

  if (result.exitCode === 0) {
    return {
      gate: "lint",
      passed: true,
      tier: "soft",
      message: "Lint passed",
    };
  }

  const stderr = capOutput(result.stderr);
  const stdout = capOutput(result.stdout);
  const output = stderr.length > 0 ? stderr : stdout;

  return {
    gate: "lint",
    passed: false,
    tier: "soft",
    message: `Lint failed (exit ${result.exitCode})`,
    output: output || undefined,
  };
}

export function checkDiffSize(
  worktreePath: string,
  minLines: number,
  maxLines: number,
): GateResult {
  const result = Bun.spawnSync(["git", "diff", "--stat", "main..HEAD"], {
    cwd: worktreePath,
    stdin: "ignore",
  });

  const stdout = result.stdout.toString().trim();
  const lines = stdout.split("\n");
  const lastLine = lines[lines.length - 1] || "";

  // Parse "N files changed, X insertions(+), Y deletions(-)"
  let totalChanged = 0;
  const insertMatch = lastLine.match(/(\d+)\s+insertion/);
  const deleteMatch = lastLine.match(/(\d+)\s+deletion/);
  if (insertMatch) totalChanged += parseInt(insertMatch[1], 10);
  if (deleteMatch) totalChanged += parseInt(deleteMatch[1], 10);

  if (totalChanged < minLines) {
    return {
      gate: "diff_size",
      passed: false,
      tier: "soft",
      message: `Diff ${totalChanged} lines below min (${minLines}..${maxLines})`,
    };
  }

  if (totalChanged > maxLines) {
    return {
      gate: "diff_size",
      passed: false,
      tier: "soft",
      message: `Diff ${totalChanged} lines exceeds max (${minLines}..${maxLines})`,
    };
  }

  return {
    gate: "diff_size",
    passed: true,
    tier: "soft",
    message: `Diff ${totalChanged} lines within range (${minLines}..${maxLines})`,
  };
}

// ---------------------------------------------------------------------------
// Config resolver — reads grove.yaml, merges global + per-repo
// ---------------------------------------------------------------------------

export function gateConfigFor(repoName?: string | null): GateConfig {
  const globalGates = configGet("settings.quality_gates") as QualityGatesConfig | undefined;
  let repoGates: QualityGatesConfig | undefined;
  if (repoName) {
    const repos = configRepoDetail();
    const rc = repos[repoName];
    repoGates = rc?.quality_gates;
  }
  return resolveGateConfig(globalGates, repoGates);
}

// ---------------------------------------------------------------------------
// Gate orchestrator — runs all enabled gates, returns results
// ---------------------------------------------------------------------------

export function runGates(worktreePath: string, config: GateConfig): GateResult[] {
  const results: GateResult[] = [];
  if (config.commits) results.push(checkCommits(worktreePath));
  if (config.tests) results.push(checkTests(worktreePath, config.test_timeout));
  if (config.lint) results.push(checkLint(worktreePath, config.lint_timeout));
  if (config.diff_size) results.push(checkDiffSize(worktreePath, config.min_diff_lines, config.max_diff_lines));
  return results;
}

// ---------------------------------------------------------------------------
// Fix prompt builder — explains gate failures to retry workers
// ---------------------------------------------------------------------------

export function buildGateFixPrompt(gateResults: GateResult[]): string {
  const failures = gateResults.filter(r => !r.passed);
  if (failures.length === 0) return "";

  const lines = [
    "Your previous session completed but failed quality checks:",
    "",
  ];
  for (const f of failures) {
    lines.push(`- ${f.gate}: FAILED -- "${f.message}"`);
    if (f.output) {
      lines.push(`  Output: ${f.output.slice(0, 500)}`);
    }
  }
  lines.push("");
  lines.push("Fix these issues. The worktree still contains your previous work.");
  lines.push("Run tests before finishing to confirm they pass.");
  return lines.join("\n");
}
