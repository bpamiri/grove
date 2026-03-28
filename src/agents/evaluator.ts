// Grove v3 — Evaluator agent: reviews worker output, runs quality gates
// Spawned as a Claude Code session after a worker completes.
// Read-only tools only — cannot modify code.
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { parseCost } from "./stream-parser";
import type { Database } from "../broker/db";
import type { Task, Tree } from "../shared/types";

export interface EvalResult {
  passed: boolean;
  gateResults: GateResult[];
  feedback: string;
  costUsd: number;
}

interface GateResult {
  gate: string;
  passed: boolean;
  tier: "hard" | "soft";
  message: string;
  output?: string;
}

const OUTPUT_CAP = 5_000;

function capOutput(buf: Buffer): string {
  const str = buf.toString().trim();
  return str.length > OUTPUT_CAP ? str.slice(0, OUTPUT_CAP) + "\n[... truncated]" : str;
}

// ---------------------------------------------------------------------------
// Quality gate checks (run in-process, not via Claude)
// ---------------------------------------------------------------------------

/** Resolve the base git ref for a worktree (origin/main, main, origin/master, etc.) */
function resolveBaseRef(worktreePath: string, configRef?: string): string {
  if (configRef) return configRef;
  // Try common refs in order of preference
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    const check = Bun.spawnSync(["git", "rev-parse", "--verify", ref], {
      cwd: worktreePath, stdin: "ignore", stderr: "pipe",
    });
    if (check.exitCode === 0) return ref;
  }
  return "origin/main"; // fallback
}

function checkCommits(worktreePath: string, baseRef: string): GateResult {
  const result = Bun.spawnSync(["git", "log", `${baseRef}..HEAD`, "--oneline"], {
    cwd: worktreePath, stdin: "ignore",
  });
  const lines = result.stdout.toString().trim().split("\n").filter(Boolean);
  return {
    gate: "commits",
    passed: lines.length > 0,
    tier: "hard",
    message: lines.length > 0 ? `${lines.length} commit${lines.length === 1 ? "" : "s"} on branch` : "No commits found",
  };
}

function checkTests(worktreePath: string, timeoutSec: number = 60, testCommand?: string): GateResult {
  if (!testCommand) {
    // No test command configured — skip rather than guess wrong
    return { gate: "tests", passed: true, tier: "hard", message: "No test command configured — skipped" };
  }

  const result = Bun.spawnSync(["sh", "-c", testCommand], {
    cwd: worktreePath, timeout: timeoutSec * 1000, stdin: "ignore",
  });

  if (result.exitCode === 0) {
    return { gate: "tests", passed: true, tier: "hard", message: "Tests passed" };
  }

  const output = capOutput(result.stderr).length > 0 ? capOutput(result.stderr) : capOutput(result.stdout);
  return {
    gate: "tests", passed: false, tier: "hard",
    message: `Tests failed (exit ${result.exitCode})`,
    output: output || undefined,
  };
}

function checkLint(worktreePath: string, timeoutSec: number = 30, lintCommand?: string): GateResult {
  if (!lintCommand) {
    return { gate: "lint", passed: true, tier: "soft", message: "No lint command configured — skipped" };
  }

  const result = Bun.spawnSync(["sh", "-c", lintCommand], {
    cwd: worktreePath, timeout: timeoutSec * 1000, stdin: "ignore",
  });

  if (result.exitCode === 0) {
    return { gate: "lint", passed: true, tier: "soft", message: "Lint passed" };
  }

  const output = capOutput(result.stderr).length > 0 ? capOutput(result.stderr) : capOutput(result.stdout);
  return {
    gate: "lint", passed: false, tier: "soft",
    message: `Lint failed (exit ${result.exitCode})`,
    output: output || undefined,
  };
}

function checkDiffSize(worktreePath: string, min: number = 1, max: number = 5000, baseRef: string = "origin/main"): GateResult {
  const result = Bun.spawnSync(["git", "diff", "--stat", `${baseRef}..HEAD`], {
    cwd: worktreePath, stdin: "ignore",
  });

  const lastLine = result.stdout.toString().trim().split("\n").pop() ?? "";
  let total = 0;
  const ins = lastLine.match(/(\d+)\s+insertion/);
  const del = lastLine.match(/(\d+)\s+deletion/);
  if (ins) total += parseInt(ins[1], 10);
  if (del) total += parseInt(del[1], 10);

  if (total < min) return { gate: "diff_size", passed: false, tier: "soft", message: `Diff ${total} lines below min (${min})` };
  if (total > max) return { gate: "diff_size", passed: false, tier: "soft", message: `Diff ${total} lines exceeds max (${max})` };
  return { gate: "diff_size", passed: true, tier: "soft", message: `${total} lines changed` };
}

// ---------------------------------------------------------------------------
// Gate orchestrator
// ---------------------------------------------------------------------------

interface GateConfig {
  commits: boolean;
  tests: boolean;
  lint: boolean;
  diff_size: boolean;
  test_timeout: number;
  lint_timeout: number;
  min_diff_lines: number;
  max_diff_lines: number;
  test_command?: string;
  lint_command?: string;
  base_ref?: string;
}

const DEFAULT_GATE_CONFIG: GateConfig = {
  commits: true, tests: true, lint: false, diff_size: true,
  test_timeout: 60, lint_timeout: 30, min_diff_lines: 1, max_diff_lines: 5000,
};

function resolveGateConfig(treeConfig: string | null): GateConfig {
  if (!treeConfig) return DEFAULT_GATE_CONFIG;
  try {
    const parsed = JSON.parse(treeConfig);
    // tree.config may be { quality_gates: {...}, default_branch: "..." } or just gate config directly
    const gates = parsed.quality_gates ?? parsed;
    const config = { ...DEFAULT_GATE_CONFIG, ...gates };
    // Use default_branch as base_ref fallback if not set in quality_gates
    if (!config.base_ref && parsed.default_branch) {
      config.base_ref = `origin/${parsed.default_branch}`;
    }
    return config;
  } catch {
    return DEFAULT_GATE_CONFIG;
  }
}

function runGates(worktreePath: string, config: GateConfig): GateResult[] {
  const baseRef = resolveBaseRef(worktreePath, config.base_ref);
  const results: GateResult[] = [];
  if (config.commits) results.push(checkCommits(worktreePath, baseRef));
  if (config.tests) results.push(checkTests(worktreePath, config.test_timeout, config.test_command));
  if (config.lint) results.push(checkLint(worktreePath, config.lint_timeout, config.lint_command));
  if (config.diff_size) results.push(checkDiffSize(worktreePath, config.min_diff_lines, config.max_diff_lines, baseRef));
  return results;
}

// ---------------------------------------------------------------------------
// Evaluator entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a completed task. Runs quality gates.
 * Returns pass/fail with detailed gate results.
 */
export function evaluate(task: Task, tree: Tree, db: Database): EvalResult {
  const sessionId = `eval-${task.id}-${Date.now()}`;

  db.sessionCreate(sessionId, task.id, "evaluator");
  db.addEvent(task.id, sessionId, "eval_started", "Evaluator started");
  bus.emit("eval:started", { taskId: task.id, sessionId });

  const worktreePath = task.worktree_path;
  if (!worktreePath || !existsSync(worktreePath)) {
    const result: EvalResult = {
      passed: false,
      gateResults: [],
      feedback: "Worktree not found",
      costUsd: 0,
    };
    db.sessionEnd(sessionId, "failed");
    db.addEvent(task.id, sessionId, "eval_failed", "Worktree not found");
    bus.emit("eval:failed", { taskId: task.id, feedback: "Worktree not found" });
    return result;
  }

  // Run quality gates
  const gateConfig = resolveGateConfig(tree.config);
  const gateResults = runGates(worktreePath, gateConfig);

  // Store gate results on task
  db.run("UPDATE tasks SET gate_results = ? WHERE id = ?", [JSON.stringify(gateResults), task.id]);

  // Determine pass/fail
  const hardFailures = gateResults.filter(g => !g.passed && g.tier === "hard");
  const softFailures = gateResults.filter(g => !g.passed && g.tier === "soft");
  const passed = hardFailures.length === 0;

  // Build feedback
  const feedback = gateResults
    .filter(g => !g.passed)
    .map(g => `${g.gate}: ${g.message}${g.output ? `\n${g.output.slice(0, 500)}` : ""}`)
    .join("\n\n") || "All gates passed";

  const result: EvalResult = {
    passed,
    gateResults,
    feedback,
    costUsd: 0, // Gate checks are free (no Claude API calls)
  };

  // Emit events
  for (const g of gateResults) {
    bus.emit("gate:result", {
      taskId: task.id, gate: g.gate, passed: g.passed, message: g.message,
    });
  }

  if (passed) {
    db.sessionEnd(sessionId, "completed");
    db.addEvent(task.id, sessionId, "eval_passed", `Evaluation passed (${softFailures.length} soft warnings)`);
    bus.emit("eval:passed", { taskId: task.id, feedback });
  } else {
    db.sessionEnd(sessionId, "failed");
    db.addEvent(task.id, sessionId, "eval_failed", `Evaluation failed: ${hardFailures.length} hard failures`);
    bus.emit("eval:failed", { taskId: task.id, feedback });
  }

  return result;
}

/** Build a prompt for retrying a worker after gate failures */
export function buildRetryPrompt(gateResults: GateResult[]): string {
  const failures = gateResults.filter(r => !r.passed);
  if (failures.length === 0) return "";

  const lines = ["Your previous session failed quality checks:", ""];
  for (const f of failures) {
    lines.push(`- ${f.gate}: FAILED — "${f.message}"`);
    if (f.output) lines.push(`  Output: ${f.output.slice(0, 500)}`);
  }
  lines.push("", "Fix these issues. The worktree still contains your previous work.");
  lines.push("Run tests before finishing to confirm they pass.");
  return lines.join("\n");
}
