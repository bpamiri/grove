# Windows Compatibility + Sandbox Guard Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Grove broker run on Windows and harden sandbox guard hooks with proper JSON parsing.

**Architecture:** Introduce a `platform.ts` module for cross-platform helpers, rewrite guard hooks as a hidden `grove _guard` CLI subcommand that parses `CLAUDE_TOOL_INPUT` as JSON instead of using bash `grep`, and update all POSIX-specific call sites to use the new helpers.

**Tech Stack:** Bun, Node.js `os`/`fs`/`path` modules, Bun test runner

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/shared/platform.ts` | Cross-platform helpers: `groveHome()`, `expandTilde()`, `realPath()`, `tempDir()`, `isWindows` |
| `src/cli/commands/_guard.ts` | Hidden CLI subcommand implementing all guard checks via JSON parsing |
| `tests/shared/platform.test.ts` | Unit tests for platform helpers |
| `tests/cli/guard.test.ts` | Unit tests for each guard check type |

### Modified files
| File | Change |
|------|--------|
| `src/shared/worktree.ts` | `expandHome()` delegates to `expandTilde()`; `listWorktrees()` uses `realPath()` instead of `pwd -P` |
| `src/shared/sandbox.ts` | `buildGuardHooks()` and `buildReviewGuardHooks()` emit `grove _guard` commands; remove bash pattern constants |
| `src/broker/db.ts` | `getEnv()` uses `groveHome()` |
| `src/cli/index.ts` | Register `_guard` in commands map |
| `src/cli/update-check.ts` | `getGroveHome()` uses `groveHome()` from platform |
| `src/cli/commands/trees.ts` | Replace `process.env.HOME` with `homedir()` |
| `src/merge/manager.ts` | Replace `process.env.HOME` with `expandTilde()` |
| `docs/getting-started/installation.md` | Add Windows section |

---

### Task 1: Create `src/shared/platform.ts` with tests

**Files:**
- Create: `src/shared/platform.ts`
- Create: `tests/shared/platform.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/shared/platform.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { groveHome, expandTilde, realPath, tempDir, isWindows } from "../../src/shared/platform";

describe("expandTilde", () => {
  test("expands ~/path to homedir/path", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  test("expands bare ~ to homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  test("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  test("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("groveHome", () => {
  const origGroveHome = process.env.GROVE_HOME;

  afterEach(() => {
    if (origGroveHome !== undefined) {
      process.env.GROVE_HOME = origGroveHome;
    } else {
      delete process.env.GROVE_HOME;
    }
  });

  test("defaults to homedir/.grove", () => {
    delete process.env.GROVE_HOME;
    expect(groveHome()).toBe(`${homedir()}/.grove`);
  });

  test("respects GROVE_HOME env override", () => {
    process.env.GROVE_HOME = "/custom/grove";
    expect(groveHome()).toBe("/custom/grove");
  });
});

describe("realPath", () => {
  test("resolves existing directory", () => {
    const resolved = realPath(tmpdir());
    expect(typeof resolved).toBe("string");
    expect(existsSync(resolved)).toBe(true);
  });
});

describe("tempDir", () => {
  test("returns a valid directory", () => {
    const dir = tempDir();
    expect(typeof dir).toBe("string");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("isWindows", () => {
  test("is a boolean", () => {
    expect(typeof isWindows).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/shared/platform.test.ts`
Expected: FAIL — module `../../src/shared/platform` not found.

- [ ] **Step 3: Write the implementation**

Create `src/shared/platform.ts`:

```typescript
// Grove v3 — Cross-platform helpers
// Centralizes all platform-specific logic so the rest of the codebase stays portable.
import { homedir, tmpdir, platform } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Cross-platform Grove home directory */
export function groveHome(): string {
  return process.env.GROVE_HOME || join(homedir(), ".grove");
}

/** Expand ~ to home directory */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Cross-platform real path resolution (replaces pwd -P) */
export function realPath(p: string): string {
  return realpathSync(p);
}

/** Cross-platform temp directory */
export function tempDir(): string {
  return tmpdir();
}

/** Whether we're running on Windows */
export const isWindows = platform() === "win32";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/shared/platform.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/platform.ts tests/shared/platform.test.ts
git commit -m "feat: add cross-platform helpers (platform.ts) (#115)"
```

---

### Task 2: Replace POSIX assumptions across call sites

**Files:**
- Modify: `src/shared/worktree.ts:8-11` (expandHome) and `src/shared/worktree.ts:140-141` (listWorktrees pwd -P)
- Modify: `src/broker/db.ts:539`
- Modify: `src/cli/update-check.ts:56-57`
- Modify: `src/cli/commands/trees.ts:98`
- Modify: `src/merge/manager.ts:198-199`

- [ ] **Step 1: Update `src/shared/worktree.ts`**

Replace the `expandHome` function (lines 8-11) to delegate to `expandTilde`:

```typescript
// Old:
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/** Expand ~ to $HOME */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

// New:
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { expandTilde, realPath } from "./platform";

/** Expand ~ to home directory */
export function expandHome(p: string): string {
  return expandTilde(p);
}
```

Replace the `pwd -P` call in `listWorktrees` (lines 139-141):

```typescript
// Old:
  const resolveResult = Bun.spawnSync(["pwd", "-P"], { cwd: repoPath });
  const resolvedPath = resolveResult.stdout.toString().trim();

// New:
  const resolvedPath = realPath(repoPath);
```

- [ ] **Step 2: Update `src/broker/db.ts`**

Replace `getEnv()` (line 539):

```typescript
// Old:
import { join } from "node:path";
// ... (existing import)
export function getEnv() {
  const GROVE_HOME = process.env.GROVE_HOME || join(process.env.HOME || "~", ".grove");

// New:
import { groveHome } from "../shared/platform";
// ... (existing imports)
export function getEnv() {
  const GROVE_HOME = groveHome();
```

- [ ] **Step 3: Update `src/cli/update-check.ts`**

Replace `getGroveHome()` (lines 56-58):

```typescript
// Old:
function getGroveHome(): string {
  return process.env.GROVE_HOME || join(process.env.HOME || "~", ".grove");
}

// New:
import { groveHome } from "../shared/platform";

// Then replace all calls to getGroveHome() with groveHome() and remove the local function.
```

Specifically, line 57 becomes an import, and lines 101 use `groveHome()` directly:

```typescript
// Old line 101:
    const groveHome = getGroveHome();

// New line 101:
    const groveDir = groveHome();
```

Update the `getCachePath()` function (line 60-62):

```typescript
// Old:
function getCachePath(): string {
  return join(getGroveHome(), "update-check.json");
}

// New:
function getCachePath(): string {
  return join(groveHome(), "update-check.json");
}
```

- [ ] **Step 4: Update `src/cli/commands/trees.ts`**

Replace line 98:

```typescript
// Old:
  const home = process.env.HOME || "";
  const storedPath = treePath.startsWith(home) ? `~${treePath.slice(home.length)}` : treePath;

// New:
  import { homedir } from "node:os";
  // (add to top-level imports)

  const home = homedir();
  const storedPath = treePath.startsWith(home) ? `~${treePath.slice(home.length)}` : treePath;
```

- [ ] **Step 5: Update `src/merge/manager.ts`**

Replace lines 198-199:

```typescript
// Old:
    const repoPath = tree.path.startsWith("~/")
      ? tree.path.replace("~", process.env.HOME || "~")
      : tree.path;

// New:
    import { expandTilde } from "../shared/platform";
    // (add to top-level imports)

    const repoPath = expandTilde(tree.path);
```

- [ ] **Step 6: Run the full test suite**

Run: `bun test tests/`
Expected: All existing tests PASS (no behavioral changes, just swapped implementations).

- [ ] **Step 7: Commit**

```bash
git add src/shared/worktree.ts src/broker/db.ts src/cli/update-check.ts src/cli/commands/trees.ts src/merge/manager.ts
git commit -m "refactor: replace POSIX assumptions with platform helpers (#115)"
```

---

### Task 3: Implement `grove _guard` subcommand with tests

**Files:**
- Create: `src/cli/commands/_guard.ts`
- Create: `tests/cli/guard.test.ts`
- Modify: `src/cli/index.ts:6`

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/guard.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

// We test the guard logic functions directly rather than spawning a process.
// The run() function is the CLI entry point — we test the internal helpers.
import {
  checkBashDanger,
  checkEditBoundary,
  checkReviewWrite,
  checkReviewBash,
} from "../../src/cli/commands/_guard";

const WORKTREE = join(tmpdir(), "grove-test-guard-wt");

beforeEach(() => {
  mkdirSync(WORKTREE, { recursive: true });
});

afterEach(() => {
  rmSync(WORKTREE, { recursive: true, force: true });
});

describe("checkBashDanger", () => {
  test("blocks git push", () => {
    const result = checkBashDanger({ command: "git push origin main" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("git push");
  });

  test("blocks git reset --hard", () => {
    const result = checkBashDanger({ command: "git reset --hard HEAD~1" });
    expect(result.blocked).toBe(true);
  });

  test("blocks rm -rf /", () => {
    const result = checkBashDanger({ command: "rm -rf /" });
    expect(result.blocked).toBe(true);
  });

  test("blocks sudo", () => {
    const result = checkBashDanger({ command: "sudo apt install foo" });
    expect(result.blocked).toBe(true);
  });

  test("case insensitive", () => {
    const result = checkBashDanger({ command: "Git Push origin main" });
    expect(result.blocked).toBe(true);
  });

  test("allows git log", () => {
    const result = checkBashDanger({ command: "git log --oneline" });
    expect(result.blocked).toBe(false);
  });

  test("allows bun test", () => {
    const result = checkBashDanger({ command: "bun test tests/" });
    expect(result.blocked).toBe(false);
  });

  test("allows empty input", () => {
    const result = checkBashDanger({});
    expect(result.blocked).toBe(false);
  });
});

describe("checkEditBoundary", () => {
  test("allows path inside worktree", () => {
    const filePath = join(WORKTREE, "src", "index.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("allows path in temp dir", () => {
    const filePath = join(tmpdir(), "grove-scratch", "file.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks path outside worktree", () => {
    const result = checkEditBoundary({ file_path: "/etc/passwd" }, WORKTREE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("outside worktree");
  });

  test("handles path with spaces", () => {
    const filePath = join(WORKTREE, "my folder", "file.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks relative path resolving outside worktree", () => {
    const filePath = join(WORKTREE, "..", "..", "etc", "passwd");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(true);
  });

  test("allows when file_path is missing", () => {
    const result = checkEditBoundary({}, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});

describe("checkReviewWrite", () => {
  test("allows .grove/review-result.json", () => {
    const filePath = join(WORKTREE, ".grove", "review-result.json");
    const result = checkReviewWrite({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks any other path", () => {
    const filePath = join(WORKTREE, "src", "index.ts");
    const result = checkReviewWrite({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("review-result.json");
  });

  test("allows when file_path is missing", () => {
    const result = checkReviewWrite({}, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});

describe("checkReviewBash", () => {
  test("blocks git commit", () => {
    const result = checkReviewBash({ command: "git commit -m 'test'" });
    expect(result.blocked).toBe(true);
  });

  test("blocks git add", () => {
    const result = checkReviewBash({ command: "git add ." });
    expect(result.blocked).toBe(true);
  });

  test("blocks git checkout", () => {
    const result = checkReviewBash({ command: "git checkout main" });
    expect(result.blocked).toBe(true);
  });

  test("blocks git push", () => {
    const result = checkReviewBash({ command: "git push origin main" });
    expect(result.blocked).toBe(true);
  });

  test("allows git log", () => {
    const result = checkReviewBash({ command: "git log --oneline" });
    expect(result.blocked).toBe(false);
  });

  test("allows git diff", () => {
    const result = checkReviewBash({ command: "git diff HEAD" });
    expect(result.blocked).toBe(false);
  });
});

describe("missing/malformed input", () => {
  test("checkBashDanger with malformed JSON gracefully returns not blocked", () => {
    // Simulates what happens when CLAUDE_TOOL_INPUT is not valid JSON
    const result = checkBashDanger(null as any);
    expect(result.blocked).toBe(false);
  });

  test("checkEditBoundary with malformed JSON gracefully returns not blocked", () => {
    const result = checkEditBoundary(null as any, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/guard.test.ts`
Expected: FAIL — module `../../src/cli/commands/_guard` not found.

- [ ] **Step 3: Write the implementation**

Create `src/cli/commands/_guard.ts`:

```typescript
// Grove v3 — Guard subcommand: sandbox enforcement for worker/reviewer agents.
// Invoked as PreToolUse hooks: grove _guard <check-type> <worktree-path>
// Reads CLAUDE_TOOL_INPUT from env, parses JSON, validates.
// Exit 0 = allow, exit 2 = block.
import { resolve, sep, join } from "node:path";
import { tempDir } from "../../shared/platform";

// ---------------------------------------------------------------------------
// Blocked patterns
// ---------------------------------------------------------------------------

const WORKER_BLOCKED_PATTERNS = [
  "git push", "git reset --hard", "rm -rf /", "sudo ",
];

const REVIEWER_BLOCKED_PATTERNS = [
  ...WORKER_BLOCKED_PATTERNS,
  "git add", "git commit", "git checkout", "git rebase",
  "git merge", "git cherry-pick", "git stash",
];

// ---------------------------------------------------------------------------
// Check result type
// ---------------------------------------------------------------------------

export interface GuardResult {
  blocked: boolean;
  reason?: string;
}

const ALLOW: GuardResult = { blocked: false };

function block(reason: string): GuardResult {
  return { blocked: true, reason };
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

export function checkBashDanger(input: any): GuardResult {
  if (!input || typeof input.command !== "string") return ALLOW;
  const cmd = input.command.toLowerCase();
  for (const pattern of WORKER_BLOCKED_PATTERNS) {
    if (cmd.includes(pattern.toLowerCase())) {
      return block(`${pattern} is not allowed in Grove workers`);
    }
  }
  return ALLOW;
}

export function checkEditBoundary(input: any, worktreePath: string): GuardResult {
  if (!input || typeof input.file_path !== "string") return ALLOW;
  const resolved = resolve(input.file_path);
  const wtResolved = resolve(worktreePath);
  if (resolved.startsWith(wtResolved + sep) || resolved === wtResolved) return ALLOW;
  const tmpResolved = resolve(tempDir());
  if (resolved.startsWith(tmpResolved + sep) || resolved === tmpResolved) return ALLOW;
  return block(`${input.file_path} is outside worktree`);
}

export function checkReviewWrite(input: any, worktreePath: string): GuardResult {
  if (!input || typeof input.file_path !== "string") return ALLOW;
  const resolved = resolve(input.file_path);
  const allowed = resolve(join(worktreePath, ".grove", "review-result.json"));
  if (resolved === allowed) return ALLOW;
  return block("Reviewer can only write to .grove/review-result.json");
}

export function checkReviewBash(input: any): GuardResult {
  if (!input || typeof input.command !== "string") return ALLOW;
  const cmd = input.command.toLowerCase();
  for (const pattern of REVIEWER_BLOCKED_PATTERNS) {
    if (cmd.includes(pattern.toLowerCase())) {
      return block(`${pattern} is not allowed for reviewers`);
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const CHECKS: Record<string, (input: any, worktreePath: string) => GuardResult> = {
  "bash-danger": (input, _wt) => checkBashDanger(input),
  "edit-boundary": (input, wt) => checkEditBoundary(input, wt),
  "review-write": (input, wt) => checkReviewWrite(input, wt),
  "review-bash": (input, _wt) => checkReviewBash(input),
};

export async function run(args: string[]): Promise<void> {
  const checkType = args[0];
  const worktreePath = args[1] || "";

  const checkFn = CHECKS[checkType];
  if (!checkFn) {
    console.error(`Unknown guard check: ${checkType}`);
    process.exit(1);
  }

  let input: any = {};
  try {
    const raw = process.env.CLAUDE_TOOL_INPUT;
    if (raw) input = JSON.parse(raw);
  } catch {
    // Malformed input — fail open (same as prior bash behavior)
    process.exit(0);
  }

  const result = checkFn(input, worktreePath);
  if (result.blocked) {
    console.error(`BLOCKED: ${result.reason}`);
    process.exit(2);
  }

  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/guard.test.ts`
Expected: All 20 tests PASS.

- [ ] **Step 5: Register in CLI index**

In `src/cli/index.ts`, add the `_guard` entry to the commands map (line ~6):

```typescript
// Add to the commands object:
  _guard: () => import("./commands/_guard"),
```

Do NOT add it to the `printUsage()` help text — it's an internal command.

- [ ] **Step 6: Run full test suite**

Run: `bun test tests/`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/_guard.ts tests/cli/guard.test.ts src/cli/index.ts
git commit -m "feat: add grove _guard subcommand for cross-platform sandbox hooks (#115, #119)"
```

---

### Task 4: Update `sandbox.ts` to emit `grove _guard` commands

**Files:**
- Modify: `src/shared/sandbox.ts:10-53` (guard hook generation section)

- [ ] **Step 1: Replace guard hook generation functions**

In `src/shared/sandbox.ts`, replace the entire guard hook generation section (lines 10-53) with:

```typescript
// ---------------------------------------------------------------------------
// Guard hook generation
// ---------------------------------------------------------------------------

interface GuardHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

function buildGuardHooks(worktreePath: string): GuardHookEntry[] {
  return [
    { matcher: "Bash", hooks: [{ type: "command", command: `grove _guard bash-danger "${worktreePath}"` }] },
    { matcher: "Write", hooks: [{ type: "command", command: `grove _guard edit-boundary "${worktreePath}"` }] },
    { matcher: "Edit", hooks: [{ type: "command", command: `grove _guard edit-boundary "${worktreePath}"` }] },
  ];
}
```

Remove the following which are no longer needed:
- `BLOCKED_BASH_PATTERNS` constant
- `SAFE_BASH_PREFIXES` constant
- `bashDangerGuard()` function
- `writeEditPathBoundary()` function

- [ ] **Step 2: Replace review guard hook generation**

Replace the review guard functions (lines 326-352) with:

```typescript
function buildReviewGuardHooks(worktreePath: string): GuardHookEntry[] {
  return [
    { matcher: "Bash", hooks: [{ type: "command", command: `grove _guard review-bash "${worktreePath}"` }] },
    { matcher: "Write", hooks: [{ type: "command", command: `grove _guard review-write "${worktreePath}"` }] },
    { matcher: "Edit", hooks: [{ type: "command", command: 'echo "BLOCKED: Reviewer cannot edit files" && exit 2' }] },
  ];
}
```

Remove the now-unused:
- `reviewWriteGuard()` function
- `reviewBashGuard()` function

Note: The Edit matcher for reviewers keeps the simple echo+exit because it's an unconditional block — no JSON parsing needed.

- [ ] **Step 3: Run full test suite**

Run: `bun test tests/`
Expected: All tests PASS. The reviewer tests (`tests/agents/reviewer.test.ts`) only import `buildReviewOverlay` and `readReviewFeedback`, which are unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/shared/sandbox.ts
git commit -m "refactor: sandbox hooks emit grove _guard commands instead of bash (#115, #119)"
```

---

### Task 5: Update installation docs for Windows

**Files:**
- Modify: `docs/getting-started/installation.md`

- [ ] **Step 1: Update the prerequisites table**

Replace the current prerequisites table with:

```markdown
## Prerequisites

| Tool | Required | macOS / Linux | Windows |
|------|----------|---------------|---------|
| **Bun** >= 1.0 | Yes | `curl -fsSL https://bun.sh/install \| bash` | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` | `npm install -g @anthropic-ai/claude-code` |
| **git** | Yes | Usually pre-installed | [Git for Windows](https://git-scm.com/download/win) |
| **gh** | No | `brew install gh` / `apt install gh` | `winget install GitHub.cli` |
| **cloudflared** | No | `brew install cloudflare/cloudflare/cloudflared` | `winget install Cloudflare.cloudflared` |

> **Optional:** Install additional agent CLIs ([Codex](https://github.com/openai/codex), [Aider](https://aider.chat/), [Gemini CLI](https://github.com/google-gemini/gemini-cli)) for multi-agent support via adapters.
```

- [ ] **Step 2: Add Windows binary install section**

After the existing Linux install block, add:

```markdown
# Windows (x64) — PowerShell
Invoke-WebRequest -Uri "https://github.com/bpamiri/grove/releases/latest/download/grove-windows-x64.tar.gz" -OutFile grove.tar.gz
tar xzf grove.tar.gz
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\grove" | Out-Null
Move-Item grove.exe "$env:LOCALAPPDATA\grove\grove.exe" -Force
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA\grove", "User")
```

Add a note after the Windows block:

```markdown
> **Windows note:** After adding to PATH, restart your terminal for the change to take effect.
```

- [ ] **Step 3: Update build-from-source for Windows**

After the existing symlink instruction, add:

```markdown
On Windows, add the `bin` directory to your PATH instead of symlinking:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$(Get-Location)\bin", "User")
```
```

- [ ] **Step 4: Update the verify section**

Update the version in the verify section to match current:

```markdown
## Verify Installation

```bash
grove --version    # Should print: grove 0.1.26
grove help         # Shows all commands
```
```

- [ ] **Step 5: Commit**

```bash
git add docs/getting-started/installation.md
git commit -m "docs: add Windows installation instructions (#116)"
```

---

### Task 6: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `bun test tests/`
Expected: All tests PASS.

- [ ] **Step 2: Verify guard command works end-to-end**

Run a manual smoke test of the guard subcommand:

```bash
# Should exit 0 (allow)
CLAUDE_TOOL_INPUT='{"command":"git log --oneline"}' bun run src/cli/index.ts _guard bash-danger /tmp/test; echo "exit: $?"

# Should exit 2 (block)
CLAUDE_TOOL_INPUT='{"command":"git push origin main"}' bun run src/cli/index.ts _guard bash-danger /tmp/test; echo "exit: $?"

# Should exit 0 (path inside worktree)
CLAUDE_TOOL_INPUT='{"file_path":"/tmp/test/src/index.ts"}' bun run src/cli/index.ts _guard edit-boundary /tmp/test; echo "exit: $?"

# Should exit 2 (path outside worktree)
CLAUDE_TOOL_INPUT='{"file_path":"/etc/passwd"}' bun run src/cli/index.ts _guard edit-boundary /tmp/test; echo "exit: $?"
```

- [ ] **Step 3: Verify no remaining POSIX assumptions**

Run: `grep -rn 'process\.env\.HOME' src/`
Expected: No results.

Run: `grep -rn 'pwd -P' src/`
Expected: No results.

Run: `grep -rn '"/tmp/"' src/`
Expected: No results (only in tests, which is fine).

- [ ] **Step 4: Commit any remaining fixes**

If any issues found in steps 1-3, fix and commit.
