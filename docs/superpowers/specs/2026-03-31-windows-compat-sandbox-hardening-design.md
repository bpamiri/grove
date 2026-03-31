# Windows Compatibility + Sandbox Guard Hardening

**Issues:** #115, #119
**Date:** 2026-03-31
**Status:** Approved

## Problem

Grove ships a `grove-windows-x64` binary in releases, but the broker crashes on Windows due to POSIX assumptions:

- `process.env.HOME` is undefined on Windows
- `pwd -P` for symlink resolution has no Windows equivalent
- Guard hooks use bash `grep`/`sed` one-liners that require a Unix shell
- Temp path allow-list hardcodes `/tmp/` and `/private/tmp/`

The guard hooks are also fragile on all platforms — they parse JSON with `grep -o` regex, which misses spaces after colons, escaped quotes, and multi-line values.

## Approach

Single unified pass: introduce a platform abstraction layer, rewrite guard hooks as a `grove _guard` subcommand using proper JSON parsing, and update installation docs for Windows.

## Design

### 1. Platform Helpers — `src/shared/platform.ts`

Centralizes all platform-specific logic in one module:

```typescript
import { homedir, tmpdir, platform } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Cross-platform Grove home (replaces process.env.GROVE_HOME || process.env.HOME + .grove) */
export function groveHome(): string {
  return process.env.GROVE_HOME || join(homedir(), ".grove");
}

/** Expand ~ to home directory (replaces manual process.env.HOME expansion) */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Cross-platform real path (replaces Bun.spawnSync(["pwd", "-P"])) */
export function realPath(p: string): string {
  return realpathSync(p);
}

/** Cross-platform temp directory (replaces hardcoded /tmp/) */
export function tempDir(): string {
  return tmpdir();
}

/** Whether we're running on Windows */
export const isWindows = platform() === "win32";
```

**Call sites to update:**

| File | Current | Replacement |
|------|---------|-------------|
| `src/shared/worktree.ts` `expandHome()` | `process.env.HOME` | Delegate to `expandTilde()` |
| `src/shared/worktree.ts` `listWorktrees()` | `Bun.spawnSync(["pwd", "-P"])` | `realPath()` |
| `src/broker/db.ts` `openDb()` | `process.env.GROVE_HOME \|\| join(process.env.HOME, ".grove")` | `groveHome()` |
| `src/cli/update-check.ts` | `process.env.GROVE_HOME \|\| join(process.env.HOME, ".grove")` | `groveHome()` |
| `src/cli/commands/trees.ts` | `process.env.HOME` | `homedir()` from `node:os` |
| `src/merge/manager.ts` | `process.env.HOME` | `expandTilde()` |

### 2. Guard Subcommand — `grove _guard`

A hidden CLI subcommand that replaces all bash guard hook logic. Registered in `src/cli/index.ts` but omitted from help output.

**Entry:** `src/cli/commands/_guard.ts`

**Invocation:** `grove _guard <check-type> <worktree-path>`

Reads `CLAUDE_TOOL_INPUT` from environment (set by Claude Code for PreToolUse hooks), parses as JSON, validates.

**Check types:**

| Check | Replaces | Logic |
|-------|----------|-------|
| `bash-danger` | `bashDangerGuard()` | Parse `command` field from JSON, check against blocked patterns list |
| `edit-boundary` | `writeEditPathBoundary()` | Parse `file_path` from JSON, verify resolved path is inside worktree or temp dir |
| `review-write` | `reviewWriteGuard()` | Parse `file_path` from JSON, only allow `<worktree>/.grove/review-result.json` |
| `review-bash` | `reviewBashGuard()` | Like `bash-danger` but with expanded blocked list (adds git add/commit/checkout/rebase/merge/cherry-pick/stash) |

**Exit codes:** `0` = allow, `2` = block (message printed to stderr).

**Path validation logic:**

```typescript
import { resolve, sep } from "node:path";
import { tempDir } from "../../shared/platform";

function isInsideWorktree(filePath: string, worktreePath: string): boolean {
  const resolved = resolve(filePath);
  const wtResolved = resolve(worktreePath);
  return resolved.startsWith(wtResolved + sep) || resolved === wtResolved;
}

function isInTempDir(filePath: string): boolean {
  const resolved = resolve(filePath);
  return resolved.startsWith(resolve(tempDir()) + sep);
}
```

**Blocked command matching:** Same list as today (`git push`, `git reset --hard`, `rm -rf /`, `sudo`), checked via case-insensitive substring match on the parsed `command` string. Review mode adds git mutation commands.

**Missing/malformed env:** If `CLAUDE_TOOL_INPUT` is absent or unparseable, exit 0 (fail open — same as current behavior where empty input passes the grep checks).

### 3. Sandbox Hook Generation Changes

`sandbox.ts` functions change their output but not their interface:

**Before (bash):**
```typescript
function bashDangerGuard(): string {
  return `echo "$CLAUDE_TOOL_INPUT" | grep -qiF 'git push' && echo "BLOCKED" && exit 2; exit 0`;
}
```

**After (grove _guard):**
```typescript
function bashDangerGuard(): string {
  return `grove _guard bash-danger "${worktreePath}"`;
}
```

The `buildGuardHooks()` and `buildReviewGuardHooks()` functions return the same `GuardHookEntry[]` shape — only the `command` strings change. All consumers (`deploySandbox`, `deployReviewSandbox`) are unaffected.

**Blocked patterns and safe prefixes** move from `sandbox.ts` constants to `_guard.ts` where they're actually evaluated. `sandbox.ts` retains the overlay generation (CLAUDE.md building) which is platform-independent.

### 4. Installation Docs

Update `docs/getting-started/installation.md`:

**Prerequisites table** — add Windows-specific install commands:
- Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`
- Git: Git for Windows from git-scm.com
- gh: `winget install GitHub.cli`
- cloudflared: `winget install Cloudflare.cloudflared`

**Binary install** — add Windows (x64) PowerShell block:
```powershell
Invoke-WebRequest -Uri "https://github.com/bpamiri/grove/releases/latest/download/grove-windows-x64.tar.gz" -OutFile grove.tar.gz
tar xzf grove.tar.gz
Move-Item grove.exe "$env:LOCALAPPDATA\grove\grove.exe"
# Add to PATH:
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA\grove", "User")
```

**Build from source** — note that Windows uses the same commands (Bun is cross-platform), but symlink step replaced with adding `bin/` to PATH.

**Not in scope:** Homebrew tap, scoop manifest, winget manifest.

## Files

### New
- `src/shared/platform.ts` — cross-platform helpers
- `src/cli/commands/_guard.ts` — guard subcommand
- `tests/shared/platform.test.ts` — platform helper tests
- `tests/cli/guard.test.ts` — guard check tests

### Modified
- `src/shared/worktree.ts` — use `expandTilde()` and `realPath()`
- `src/shared/sandbox.ts` — emit `grove _guard` commands, move pattern constants to `_guard.ts`
- `src/broker/db.ts` — use `groveHome()`
- `src/cli/index.ts` — register `_guard` command
- `src/cli/commands/trees.ts` — use `homedir()`
- `src/cli/update-check.ts` — use `groveHome()`
- `src/merge/manager.ts` — use `expandTilde()`
- `docs/getting-started/installation.md` — add Windows section

## Testing

### `tests/shared/platform.test.ts`
- `expandTilde("~/foo")` returns `homedir() + "/foo"`
- `expandTilde("~")` returns `homedir()`
- `expandTilde("/abs/path")` returns unchanged
- `groveHome()` defaults to `homedir() + "/.grove"`
- `groveHome()` respects `GROVE_HOME` env override
- `tempDir()` returns a valid directory path

### `tests/cli/guard.test.ts`
- **bash-danger:** blocked pattern (`git push`) → exit 2, safe command (`git log`) → exit 0
- **bash-danger:** case insensitive (`Git Push`) → exit 2
- **edit-boundary:** path inside worktree → exit 0
- **edit-boundary:** path in temp dir → exit 0
- **edit-boundary:** path outside worktree → exit 2
- **edit-boundary:** path with spaces → correct handling
- **edit-boundary:** relative path resolving outside worktree → exit 2
- **review-write:** `.grove/review-result.json` → exit 0, any other path → exit 2
- **review-bash:** `git commit` → exit 2, `git log` → exit 0
- **missing env:** no `CLAUDE_TOOL_INPUT` → exit 0 (fail open)
- **malformed env:** invalid JSON → exit 0 (fail open)

### Existing tests
Sandbox tests that assert on guard hook command strings update to expect `grove _guard ...` instead of bash one-liners. No behavioral change to overlay generation tests.
