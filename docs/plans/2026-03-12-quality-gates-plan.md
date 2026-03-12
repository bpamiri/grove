# Worker Quality Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate worker output (commits, tests, lint, diff size) between worker completion and PR publishing, with tiered responses (auto-retry for hard failures, review for soft failures).

**Architecture:** New `src/lib/gates.ts` module with pure gate-check functions + orchestrator. Dispatch.ts calls `runGates()` after worker exits 0, before setting status/publishing. Gate config merges global defaults from `grove.yaml` settings with per-repo overrides.

**Tech Stack:** TypeScript, Bun (spawnSync for git/test/lint commands), bun:test

---

### Task 1: Types and gate config resolution

**Files:**
- Modify: `src/types.ts` (add GateResult, GateConfig, QualityGatesConfig interfaces + 3 EventType values)
- Create: `src/lib/gates.ts` (config resolution only — gates come in later tasks)
- Create: `tests/lib/gates.test.ts`

**Step 1: Add types to `src/types.ts`**

Add after the `SandboxConfig` interface (line ~205):

```typescript
// ---------------------------------------------------------------------------
// Quality gate types
// ---------------------------------------------------------------------------

export interface GateResult {
  gate: string;
  passed: boolean;
  tier: "hard" | "soft";
  message: string;
}

export interface GateConfig {
  commits: boolean;
  tests: boolean;
  lint: boolean;
  diff_size: boolean;
  min_diff_lines: number;
  max_diff_lines: number;
  test_timeout: number;
  lint_timeout: number;
}

export interface QualityGatesConfig {
  commits?: boolean;
  tests?: boolean;
  lint?: boolean;
  diff_size?: boolean;
  min_diff_lines?: number;
  max_diff_lines?: number;
  test_timeout?: number;
  lint_timeout?: number;
}
```

Add 3 new values to the `EventType` enum (after `RetryExhausted`):

```typescript
  GatePassed = "gate_passed",
  GateFailed = "gate_failed",
  GateRetry = "gate_retry",
```

Add `quality_gates?: QualityGatesConfig` to the `SettingsConfig` interface.

Add `quality_gates?: QualityGatesConfig` to the `RepoConfig` interface.

**Step 2: Write the failing test for config resolution**

Create `tests/lib/gates.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { resolveGateConfig, DEFAULT_GATE_CONFIG } from "../../src/lib/gates";

describe("resolveGateConfig", () => {
  test("returns defaults when no overrides", () => {
    const config = resolveGateConfig(undefined, undefined);
    expect(config).toEqual(DEFAULT_GATE_CONFIG);
  });

  test("global overrides change defaults", () => {
    const config = resolveGateConfig({ lint: true, max_diff_lines: 10000 }, undefined);
    expect(config.lint).toBe(true);
    expect(config.max_diff_lines).toBe(10000);
    expect(config.commits).toBe(true); // unchanged default
  });

  test("repo overrides take precedence over global", () => {
    const config = resolveGateConfig({ tests: true, lint: true }, { tests: false });
    expect(config.tests).toBe(false); // repo wins
    expect(config.lint).toBe(true);   // global applies
  });

  test("repo overrides work without global", () => {
    const config = resolveGateConfig(undefined, { lint: true });
    expect(config.lint).toBe(true);
    expect(config.commits).toBe(true); // default
  });
});
```

**Step 3: Run test to verify it fails**

Run: `bun test tests/lib/gates.test.ts`
Expected: FAIL — module not found

**Step 4: Implement config resolution in `src/lib/gates.ts`**

```typescript
// Grove v2 — Worker quality gates
// Validates worker output between completion and PR publishing.
import type { GateConfig, GateResult, QualityGatesConfig } from "../types";

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

export function resolveGateConfig(
  global?: QualityGatesConfig,
  repo?: QualityGatesConfig,
): GateConfig {
  return {
    ...DEFAULT_GATE_CONFIG,
    ...(global ?? {}),
    ...(repo ?? {}),
  };
}
```

**Step 5: Run test to verify it passes**

Run: `bun test tests/lib/gates.test.ts`
Expected: PASS (4 tests)

**Step 6: Commit**

```bash
git add src/types.ts src/lib/gates.ts tests/lib/gates.test.ts
git commit -m "feat: add quality gate types and config resolution"
```

---

### Task 2: Individual gate checks

**Files:**
- Modify: `src/lib/gates.ts` (add checkCommits, checkTests, checkLint, checkDiffSize)
- Modify: `tests/lib/gates.test.ts` (add tests for each gate)

**Step 1: Write failing tests for checkCommits**

Add to `tests/lib/gates.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGateConfig,
  DEFAULT_GATE_CONFIG,
  checkCommits,
  checkTests,
  checkLint,
  checkDiffSize,
} from "../../src/lib/gates";

let tempDir: string;

function setupGitWorktree(): string {
  // Create a minimal git repo to simulate a worktree
  tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
  Bun.spawnSync(["git", "init"], { cwd: tempDir });
  Bun.spawnSync(["git", "checkout", "-b", "main"], { cwd: tempDir });
  writeFileSync(join(tempDir, "README.md"), "init");
  Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: tempDir });
  // Create a feature branch
  Bun.spawnSync(["git", "checkout", "-b", "grove/T-001-test"], { cwd: tempDir });
  return tempDir;
}

describe("checkCommits", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("fails when no commits on branch", () => {
    setupGitWorktree();
    const result = checkCommits(tempDir);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("hard");
    expect(result.gate).toBe("commits");
  });

  test("passes when commits exist on branch", () => {
    setupGitWorktree();
    writeFileSync(join(tempDir, "new.ts"), "export const x = 1;");
    Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
    Bun.spawnSync(["git", "commit", "-m", "feat: add new file"], { cwd: tempDir });
    const result = checkCommits(tempDir);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("hard");
  });
});
```

**Step 2: Write failing tests for checkDiffSize**

```typescript
describe("checkDiffSize", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("passes when diff within range", () => {
    setupGitWorktree();
    writeFileSync(join(tempDir, "src/app.ts"), "const x = 1;\nconst y = 2;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
    Bun.spawnSync(["git", "commit", "-m", "add code"], { cwd: tempDir });
    const result = checkDiffSize(tempDir, 1, 5000);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("soft");
  });

  test("fails when diff too large", () => {
    setupGitWorktree();
    const bigContent = Array(100).fill("const x = 1;").join("\n");
    writeFileSync(join(tempDir, "big.ts"), bigContent);
    Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
    Bun.spawnSync(["git", "commit", "-m", "add big file"], { cwd: tempDir });
    const result = checkDiffSize(tempDir, 1, 10);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("exceeds max");
  });

  test("fails when diff empty (below min)", () => {
    setupGitWorktree();
    // No commits on branch -> 0 lines
    const result = checkDiffSize(tempDir, 1, 5000);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("below min");
  });
});
```

**Step 3: Write failing tests for checkTests**

```typescript
describe("checkTests", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("auto-passes when no test runner detected", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
    const result = checkTests(tempDir, 60);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("No test runner");
  });

  test("passes when tests succeed", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
    // Create package.json with a passing test script
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    const result = checkTests(tempDir, 60);
    expect(result.passed).toBe(true);
  });

  test("fails when tests fail", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
    const result = checkTests(tempDir, 60);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("hard");
  });
});
```

**Step 4: Write failing tests for checkLint**

```typescript
describe("checkLint", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("auto-passes when no linter detected", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-gates-test-"));
    const result = checkLint(tempDir, 30);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("No linter");
  });
});
```

**Step 5: Run tests to verify they fail**

Run: `bun test tests/lib/gates.test.ts`
Expected: FAIL — functions not exported

**Step 6: Implement gate checks in `src/lib/gates.ts`**

Add imports and gate functions after the config resolution section:

```typescript
import { detectToolchain } from "./scanner";

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
// Gate: commits
// ---------------------------------------------------------------------------

export function checkCommits(worktreePath: string): GateResult {
  const result = Bun.spawnSync(["git", "log", "main..HEAD", "--oneline"], {
    cwd: worktreePath,
  });

  const output = result.stdout.toString().trim();
  const commitCount = output ? output.split("\n").length : 0;

  if (commitCount === 0) {
    return {
      gate: "commits",
      passed: false,
      tier: "hard",
      message: "No commits found on branch (expected at least 1)",
    };
  }

  return {
    gate: "commits",
    passed: true,
    tier: "hard",
    message: `${commitCount} commit(s) on branch`,
  };
}

// ---------------------------------------------------------------------------
// Gate: tests
// ---------------------------------------------------------------------------

export function checkTests(worktreePath: string, timeoutSec: number): GateResult {
  const tc = detectToolchain(worktreePath);

  // Determine test command
  let cmd: string[];
  if (tc.runtime === "bun") {
    cmd = ["bun", "test"];
  } else if (tc.runtime === "node") {
    cmd = ["npm", "test"];
  } else if (tc.runtime === "python") {
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

  const output = capOutput(result.stderr.length > 0 ? result.stderr : result.stdout);
  return {
    gate: "tests",
    passed: false,
    tier: "hard",
    message: `Tests failed (exit ${result.exitCode}): ${output}`,
  };
}

// ---------------------------------------------------------------------------
// Gate: lint
// ---------------------------------------------------------------------------

export function checkLint(worktreePath: string, timeoutSec: number): GateResult {
  const tc = detectToolchain(worktreePath);

  if (!tc.hasLint || !tc.lintTool) {
    return {
      gate: "lint",
      passed: true,
      tier: "soft",
      message: "No linter detected -- skipped",
    };
  }

  let cmd: string[];
  if (tc.lintTool === "eslint") {
    cmd = ["npx", "eslint", "."];
  } else if (tc.lintTool === "ruff") {
    cmd = ["ruff", "check", "."];
  } else {
    return {
      gate: "lint",
      passed: true,
      tier: "soft",
      message: `Unknown linter: ${tc.lintTool} -- skipped`,
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

  const output = capOutput(result.stderr.length > 0 ? result.stderr : result.stdout);
  return {
    gate: "lint",
    passed: false,
    tier: "soft",
    message: `Lint failed (exit ${result.exitCode}): ${output}`,
  };
}

// ---------------------------------------------------------------------------
// Gate: diff_size
// ---------------------------------------------------------------------------

export function checkDiffSize(
  worktreePath: string,
  minLines: number,
  maxLines: number,
): GateResult {
  const result = Bun.spawnSync(["git", "diff", "--stat", "main..HEAD"], {
    cwd: worktreePath,
  });

  const output = result.stdout.toString().trim();

  // Parse total from last line: " N files changed, X insertions(+), Y deletions(-)"
  let totalLines = 0;
  const lines = output.split("\n");
  const lastLine = lines[lines.length - 1] || "";
  const insertMatch = lastLine.match(/(\d+)\s+insertion/);
  const deleteMatch = lastLine.match(/(\d+)\s+deletion/);
  if (insertMatch) totalLines += parseInt(insertMatch[1], 10);
  if (deleteMatch) totalLines += parseInt(deleteMatch[1], 10);

  if (totalLines < minLines) {
    return {
      gate: "diff_size",
      passed: false,
      tier: "soft",
      message: `Diff is ${totalLines} line(s) -- below min (${minLines})`,
    };
  }

  if (totalLines > maxLines) {
    return {
      gate: "diff_size",
      passed: false,
      tier: "soft",
      message: `Diff is ${totalLines} line(s) -- exceeds max (${maxLines})`,
    };
  }

  return {
    gate: "diff_size",
    passed: true,
    tier: "soft",
    message: `Diff is ${totalLines} line(s) (within ${minLines}..${maxLines})`,
  };
}
```

**Step 7: Run tests to verify they pass**

Run: `bun test tests/lib/gates.test.ts`
Expected: PASS (all tests)

**Step 8: Run full test suite**

Run: `bun test`
Expected: All pass (320+ tests)

**Step 9: Commit**

```bash
git add src/lib/gates.ts tests/lib/gates.test.ts
git commit -m "feat: add individual quality gate checks (commits, tests, lint, diff_size)"
```

---

### Task 3: Gate orchestrator (`runGates`) and fix prompt

**Files:**
- Modify: `src/lib/gates.ts` (add `runGates`, `gateConfigFor`, `buildGateFixPrompt`)
- Modify: `tests/lib/gates.test.ts` (add orchestrator and fix prompt tests)

**Step 1: Write failing tests for runGates**

Add to `tests/lib/gates.test.ts`:

```typescript
import { runGates, buildGateFixPrompt } from "../../src/lib/gates";

describe("runGates", () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns all enabled gate results", () => {
    setupGitWorktree();
    writeFileSync(join(tempDir, "src/app.ts"), "export const x = 1;\n");
    Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
    Bun.spawnSync(["git", "commit", "-m", "feat: add code"], { cwd: tempDir });

    const config = { ...DEFAULT_GATE_CONFIG, lint: false };
    const results = runGates(tempDir, config);
    // Should have commits, tests, diff_size (lint disabled)
    expect(results.length).toBe(3);
    expect(results.find(r => r.gate === "commits")?.passed).toBe(true);
    expect(results.find(r => r.gate === "diff_size")?.passed).toBe(true);
  });

  test("skips disabled gates", () => {
    setupGitWorktree();
    const config = { ...DEFAULT_GATE_CONFIG, commits: false, tests: false, lint: false, diff_size: false };
    const results = runGates(tempDir, config);
    expect(results.length).toBe(0);
  });

  test("reports hard and soft failures separately", () => {
    setupGitWorktree();
    // No commits -> hard fail on commits, soft fail on diff_size (below min)
    const config = { ...DEFAULT_GATE_CONFIG, lint: false, tests: false };
    const results = runGates(tempDir, config);
    const commitResult = results.find(r => r.gate === "commits");
    const diffResult = results.find(r => r.gate === "diff_size");
    expect(commitResult?.passed).toBe(false);
    expect(commitResult?.tier).toBe("hard");
    expect(diffResult?.passed).toBe(false);
    expect(diffResult?.tier).toBe("soft");
  });
});
```

**Step 2: Write failing tests for buildGateFixPrompt**

```typescript
describe("buildGateFixPrompt", () => {
  test("builds prompt from failed gates", () => {
    const results = [
      { gate: "commits", passed: true, tier: "hard" as const, message: "2 commits" },
      { gate: "tests", passed: false, tier: "hard" as const, message: "Tests failed (exit 1): FAIL src/app.test.ts" },
      { gate: "lint", passed: false, tier: "soft" as const, message: "Lint failed: 3 warnings" },
    ];
    const prompt = buildGateFixPrompt(results);
    expect(prompt).toContain("failed quality checks");
    expect(prompt).toContain("tests: FAILED");
    expect(prompt).toContain("lint: FAILED");
    expect(prompt).not.toContain("commits");
  });

  test("returns empty string when all pass", () => {
    const results = [
      { gate: "commits", passed: true, tier: "hard" as const, message: "ok" },
    ];
    expect(buildGateFixPrompt(results)).toBe("");
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `bun test tests/lib/gates.test.ts`
Expected: FAIL — `runGates` and `buildGateFixPrompt` not exported

**Step 4: Implement orchestrator and fix prompt**

Add to `src/lib/gates.ts`:

```typescript
import { configGet, configRepoDetail } from "../core/config";

// ---------------------------------------------------------------------------
// Config resolution from grove.yaml
// ---------------------------------------------------------------------------

export function gateConfigFor(repoName?: string | null): GateConfig {
  const globalGates = configGet("settings.quality_gates") as QualityGatesConfig | undefined;

  let repoGates: QualityGatesConfig | undefined;
  if (repoName) {
    const repos = configRepoDetail();
    const rc = repos[repoName] as any;
    repoGates = rc?.quality_gates;
  }

  return resolveGateConfig(globalGates, repoGates);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runGates(worktreePath: string, config: GateConfig): GateResult[] {
  const results: GateResult[] = [];

  if (config.commits) {
    results.push(checkCommits(worktreePath));
  }

  if (config.tests) {
    results.push(checkTests(worktreePath, config.test_timeout));
  }

  if (config.lint) {
    results.push(checkLint(worktreePath, config.lint_timeout));
  }

  if (config.diff_size) {
    results.push(checkDiffSize(worktreePath, config.min_diff_lines, config.max_diff_lines));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fix prompt for retry
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
  }

  lines.push("");
  lines.push("Fix these issues. The worktree still contains your previous work.");
  lines.push("Run tests before finishing to confirm they pass.");

  return lines.join("\n");
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/lib/gates.test.ts`
Expected: PASS

**Step 6: Run full suite**

Run: `bun test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/lib/gates.ts tests/lib/gates.test.ts
git commit -m "feat: add gate orchestrator (runGates), config resolver, and fix prompt builder"
```

---

### Task 4: Integrate gates into dispatch.ts

**Files:**
- Modify: `src/lib/dispatch.ts` (insert gate checks in both foreground and background paths)
- Modify: `schema.sql` (add `gate_results` column to tasks)
- Modify: `src/types.ts` (add `gate_results` to Task interface)

**Step 1: Add `gate_results` column to schema**

In `schema.sql`, add `gate_results TEXT` to the tasks table, after the `next_steps TEXT` line:

```sql
  gate_results TEXT,
```

**Step 2: Add `gate_results` to the Task interface**

In `src/types.ts`, add after `next_steps: string | null;` (line ~98):

```typescript
  gate_results: string | null;
```

**Step 3: Modify dispatch.ts — add imports**

At the top of `src/lib/dispatch.ts`, add:

```typescript
import { runGates, gateConfigFor, buildGateFixPrompt } from "./gates";
import { EventType, TaskStatus } from "../types";
```

Check if `EventType` or `TaskStatus` are already imported and avoid duplicates.

**Step 4: Modify foreground post-completion block**

Replace the foreground `if (exitCode === 0)` block at `dispatch.ts` lines 381-400 with the gate-aware version:

```typescript
    if (exitCode === 0) {
      // -- Quality gates --
      const gateConfig = gateConfigFor(repo);
      const gateResults = runGates(wtPath, gateConfig);
      db.taskSet(taskId, "gate_results", JSON.stringify(gateResults));

      const hardFails = gateResults.filter(r => !r.passed && r.tier === "hard");
      const softFails = gateResults.filter(r => !r.passed && r.tier === "soft");
      const allPassed = hardFails.length === 0 && softFails.length === 0;

      if (allPassed) {
        db.addEvent(taskId, EventType.GatePassed, "All quality gates passed");
        db.taskSetStatus(taskId, "done");
        db.sessionEnd(sessionId, "completed");
        ui.success(`Task ${taskId} completed -- all gates passed.`);
        notifyUnblocked(taskId);

        const published = await publishTask(taskId, db);
        if (published) {
          ui.success(`PR created for ${taskId}`);
        } else {
          ui.warn(`Auto-publish failed. Retry with: grove publish ${taskId}`);
        }
      } else if (hardFails.length > 0) {
        const task = db.taskGet(taskId)!;
        const maxRetries = task.max_retries ?? 1;
        const retryCount = task.retry_count ?? 0;

        const failSummary = hardFails.map(r => `${r.gate}: ${r.message}`).join("; ");
        db.addEvent(taskId, EventType.GateFailed, `Hard gate failure: ${failSummary}`);

        if (retryCount < maxRetries) {
          db.exec("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
          db.addEvent(taskId, EventType.GateRetry, `Auto-retry ${retryCount + 1}/${maxRetries}`);
          db.sessionEnd(sessionId, "completed");
          ui.warn(`Gate failed for ${taskId}: ${failSummary}`);
          ui.info(`Auto-retrying (${retryCount + 1}/${maxRetries})...`);

          const fixPrompt = buildGateFixPrompt(gateResults);
          db.taskSet(taskId, "next_steps", fixPrompt);
          db.taskSetStatus(taskId, "ready");
          await dispatchTask(taskId, foreground);
        } else {
          db.taskSetStatus(taskId, "failed");
          db.sessionEnd(sessionId, "failed");
          ui.error(`Task ${taskId} failed quality gates (retries exhausted): ${failSummary}`);
        }
      } else {
        const failSummary = softFails.map(r => `${r.gate}: ${r.message}`).join("; ");
        db.addEvent(taskId, EventType.GateFailed, `Soft gate failure: ${failSummary}`);
        db.taskSetStatus(taskId, TaskStatus.Review);
        db.sessionEnd(sessionId, "completed");
        ui.warn(`Task ${taskId} needs review: ${failSummary}`);
        notifyUnblocked(taskId);
      }
    } else {
      db.taskSetStatus(taskId, "failed");
      db.sessionEnd(sessionId, "failed");
      ui.error(`Task ${taskId} failed (exit ${exitCode}).`);
    }
```

**Step 5: Modify background post-completion block**

Replace the background `if (exitCode === 0)` block at `dispatch.ts` lines 464-474 with the same gate logic, using `false` for the re-dispatch foreground parameter and without console display calls.

**Step 6: Add migration for existing databases**

In `src/core/db.ts`, in the `initDb()` function (or wherever migrations run), add:

```typescript
try {
  db.exec("ALTER TABLE tasks ADD COLUMN gate_results TEXT");
} catch {
  // Column already exists
}
```

**Step 7: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 8: Commit**

```bash
git add schema.sql src/types.ts src/core/db.ts src/lib/dispatch.ts
git commit -m "feat: integrate quality gates into worker dispatch pipeline"
```

---

### Task 5: Register in help + build verification

**Files:**
- Modify: `src/commands/help.ts` (mention quality gates in Execution section)
- None new — verification only

**Step 1: Update help.ts**

No changes to the help listing needed (quality gates are automatic, not a separate command). But update the `work` command's help text in `src/commands/work.ts` to mention gates. In the `help()` function, add after the "What happens:" list:

```
  6. Runs quality gates (commits, tests, lint, diff size)
  7. Auto-retries on hard failures, marks for review on soft failures
```

**Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 3: Build binary**

Run: `bun build src/index.ts --compile --outfile bin/grove`
Expected: Build succeeds

**Step 4: Verify help output**

Run: `bin/grove work --help`
Expected: Shows quality gates info in "What happens" section

**Step 5: Commit**

```bash
git add src/commands/work.ts
git commit -m "feat: document quality gates in grove work help text"
```

---

## Unresolved Questions

- Should `max_retries` default to 1 when quality gates are enabled, or stay NULL (no retries)?
- Should `grove work --skip-gates` be an escape hatch? (Not in v1 -- can add later.)
- Should gate results be visible in `grove dashboard` live status? (Deferred.)
