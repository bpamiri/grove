# Grove Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add version checking on `grove up` and a `grove upgrade` command for self-updating the binary from GitHub Releases.

**Architecture:** A shared `update-check.ts` module handles platform detection, GitHub API calls, and cached version checks. The `upgrade` command downloads, verifies, and replaces the binary. The `up` command fires a non-blocking check after startup.

**Tech Stack:** Bun native fetch, Bun.CryptoHasher (SHA256), Bun.spawnSync (tar), bun:test

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/cli/update-check.ts` | Create | Platform detection, GitHub API fetch, cached version check |
| `src/cli/commands/upgrade.ts` | Create | Self-update command: download, verify, replace binary |
| `src/cli/index.ts` | Modify | Register `upgrade` command in router |
| `src/cli/commands/up.ts` | Modify | Fire non-blocking update check after startup |
| `tests/cli/update-check.test.ts` | Create | Tests for update-check module |
| `tests/cli/upgrade.test.ts` | Create | Tests for upgrade command |

---

### Task 1: Platform detection and GitHub API fetch

**Files:**
- Create: `src/cli/update-check.ts`
- Create: `tests/cli/update-check.test.ts`

- [ ] **Step 1: Write failing tests for `getPlatformAssetName`**

Create `tests/cli/update-check.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { getPlatformAssetName } from "../../src/cli/update-check";

describe("getPlatformAssetName", () => {
  test("returns asset name for current platform", () => {
    const name = getPlatformAssetName();
    // Must be one of the known release artifacts
    expect(["grove-darwin-arm64", "grove-darwin-x64", "grove-linux-x64"]).toContain(name);
  });

  test("returns correct format", () => {
    const name = getPlatformAssetName();
    expect(name).toMatch(/^grove-(darwin|linux)-(arm64|x64)$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/cli/update-check.test.ts
```

Expected: FAIL — module `../../src/cli/update-check` not found.

- [ ] **Step 3: Write `src/cli/update-check.ts` with `getPlatformAssetName` and `fetchLatestVersion`**

```ts
// Grove v3 — Update checking and platform detection
import { GROVE_VERSION } from "../shared/types";

const GITHUB_REPO = "bpamiri/grove";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Map current platform + arch to the release asset name */
export function getPlatformAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "grove-darwin-arm64";
  if (platform === "darwin" && arch === "x64")   return "grove-darwin-x64";
  if (platform === "linux"  && arch === "x64")   return "grove-linux-x64";

  throw new Error(`Unsupported platform: ${platform}-${arch}. Grove supports darwin-arm64, darwin-x64, and linux-x64.`);
}

export interface LatestRelease {
  version: string;
  tarballUrl: string;
  checksumUrl: string;
}

/** Fetch latest release info from GitHub */
export async function fetchLatestVersion(): Promise<LatestRelease> {
  const resp = await fetch(GITHUB_API, {
    headers: { "Accept": "application/vnd.github.v3+json" },
  });

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as { tag_name: string };
  const version = data.tag_name.replace(/^v/, "");
  const asset = getPlatformAssetName();
  const base = `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;

  return {
    version,
    tarballUrl: `${base}/${asset}.tar.gz`,
    checksumUrl: `${base}/${asset}.tar.gz.sha256`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/cli/update-check.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Add tests for `fetchLatestVersion`**

Append to `tests/cli/update-check.test.ts`:

```ts
import { fetchLatestVersion } from "../../src/cli/update-check";

const originalFetch = globalThis.fetch;

describe("fetchLatestVersion", () => {
  test("parses GitHub API response and constructs URLs", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v3.1.0" }), {
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchLatestVersion();

    expect(result.version).toBe("3.1.0");
    expect(result.tarballUrl).toContain("v3.1.0");
    expect(result.tarballUrl).toEndWith(".tar.gz");
    expect(result.checksumUrl).toEndWith(".tar.gz.sha256");

    globalThis.fetch = originalFetch;
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () =>
      new Response("rate limited", { status: 403 });

    expect(fetchLatestVersion()).rejects.toThrow("GitHub API returned 403");

    globalThis.fetch = originalFetch;
  });
});
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/cli/update-check.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/update-check.ts tests/cli/update-check.test.ts
git commit -m "feat: add platform detection and GitHub release fetch (#35)"
```

---

### Task 2: Cached update check

**Files:**
- Modify: `src/cli/update-check.ts`
- Modify: `tests/cli/update-check.test.ts`

- [ ] **Step 1: Write failing tests for `checkForUpdate`**

Append to `tests/cli/update-check.test.ts`:

```ts
import { checkForUpdate } from "../../src/cli/update-check";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("checkForUpdate", () => {
  const testHome = join(tmpdir(), "grove-test-update-" + Date.now());
  const cacheFile = join(testHome, "update-check.json");
  const origEnv = process.env.GROVE_HOME;
  const origTTY = process.stdout.isTTY;

  function setup() {
    mkdirSync(testHome, { recursive: true });
    process.env.GROVE_HOME = testHome;
  }

  function teardown() {
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
    process.env.GROVE_HOME = origEnv;
    globalThis.fetch = originalFetch;
  }

  test("writes cache file after checking", async () => {
    setup();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v3.0.0-alpha.0" }), {
        headers: { "Content-Type": "application/json" },
      });

    await checkForUpdate();

    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.latest_version).toBe("3.0.0-alpha.0");
    expect(cache.checked_at).toBeTruthy();
    teardown();
  });

  test("uses cache when recent", async () => {
    setup();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ tag_name: "v3.0.0-alpha.0" }));
    };

    // Write fresh cache
    writeFileSync(cacheFile, JSON.stringify({
      checked_at: new Date().toISOString(),
      latest_version: "3.0.0-alpha.0",
    }));

    await checkForUpdate();

    expect(fetchCalled).toBe(false);
    teardown();
  });

  test("skips when GROVE_NO_UPDATE_CHECK=1", async () => {
    setup();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ tag_name: "v99.0.0" }));
    };

    process.env.GROVE_NO_UPDATE_CHECK = "1";
    await checkForUpdate();
    delete process.env.GROVE_NO_UPDATE_CHECK;

    expect(fetchCalled).toBe(false);
    teardown();
  });

  test("silently swallows errors", async () => {
    setup();
    globalThis.fetch = async () => { throw new Error("network down"); };

    // Should not throw
    await checkForUpdate();
    teardown();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/cli/update-check.test.ts
```

Expected: FAIL — `checkForUpdate` not exported.

- [ ] **Step 3: Implement `checkForUpdate` in `src/cli/update-check.ts`**

Add to the end of `src/cli/update-check.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";

interface UpdateCache {
  checked_at: string;
  latest_version: string;
}

function getGroveHome(): string {
  return process.env.GROVE_HOME || join(process.env.HOME || "~", ".grove");
}

function getCachePath(): string {
  return join(getGroveHome(), "update-check.json");
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Non-blocking update check — call from `grove up`. Silently swallows all errors. */
export async function checkForUpdate(): Promise<void> {
  try {
    if (process.env.GROVE_NO_UPDATE_CHECK === "1") return;
    if (!process.stdout.isTTY) return;

    const cachePath = getCachePath();
    let latestVersion: string | null = null;

    // Check cache
    if (existsSync(cachePath)) {
      const cache: UpdateCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      const age = Date.now() - new Date(cache.checked_at).getTime();
      if (age < CACHE_TTL_MS) {
        latestVersion = cache.latest_version;
      }
    }

    // Fetch if cache miss or stale
    if (!latestVersion) {
      const release = await fetchLatestVersion();
      latestVersion = release.version;

      const groveHome = getGroveHome();
      if (!existsSync(groveHome)) mkdirSync(groveHome, { recursive: true });

      writeFileSync(cachePath, JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: latestVersion,
      } satisfies UpdateCache));
    }

    // Compare versions
    if (latestVersion !== GROVE_VERSION) {
      console.log(
        `\n  ${pc.yellow("Grove v" + latestVersion + " available.")} Run ${pc.bold("grove upgrade")} to update.`
      );
    }
  } catch {
    // Silent — never block startup
  }
}
```

Note: The `import` statements for `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `join`, and `pc` should be at the top of the file alongside the existing imports.

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/update-check.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/update-check.ts tests/cli/update-check.test.ts
git commit -m "feat: add cached update check (#35)"
```

---

### Task 3: `grove upgrade` command

**Files:**
- Create: `src/cli/commands/upgrade.ts`
- Create: `tests/cli/upgrade.test.ts`

- [ ] **Step 1: Write failing tests for the upgrade command**

Create `tests/cli/upgrade.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { getPlatformAssetName, fetchLatestVersion } from "../../src/cli/update-check";

const originalFetch = globalThis.fetch;

describe("upgrade prerequisites", () => {
  test("getPlatformAssetName returns valid asset for this machine", () => {
    const name = getPlatformAssetName();
    expect(name).toMatch(/^grove-(darwin|linux)-(arm64|x64)$/);
  });

  test("fetchLatestVersion constructs correct download URLs", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v4.0.0" }));

    const release = await fetchLatestVersion();
    const asset = getPlatformAssetName();

    expect(release.tarballUrl).toBe(
      `https://github.com/bpamiri/grove/releases/download/v4.0.0/${asset}.tar.gz`
    );
    expect(release.checksumUrl).toBe(
      `https://github.com/bpamiri/grove/releases/download/v4.0.0/${asset}.tar.gz.sha256`
    );

    globalThis.fetch = originalFetch;
  });
});

describe("verifyChecksum", () => {
  test("matches correct checksum", async () => {
    const { verifyChecksum } = await import("../../src/cli/commands/upgrade");
    const content = new Uint8Array([1, 2, 3, 4]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const expected = hasher.digest("hex");

    expect(verifyChecksum(content, `${expected}  grove-test.tar.gz`)).toBe(true);
  });

  test("rejects wrong checksum", async () => {
    const { verifyChecksum } = await import("../../src/cli/commands/upgrade");
    const content = new Uint8Array([1, 2, 3, 4]);
    expect(verifyChecksum(content, "0000000000000000000000000000000000000000000000000000000000000000  grove-test.tar.gz")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/cli/upgrade.test.ts
```

Expected: FAIL — `verifyChecksum` not found.

- [ ] **Step 3: Write `src/cli/commands/upgrade.ts`**

```ts
// grove upgrade — Download and install latest Grove binary
import pc from "picocolors";
import { GROVE_VERSION } from "../../shared/types";
import { fetchLatestVersion, getPlatformAssetName } from "../update-check";
import { mkdtempSync, writeFileSync, unlinkSync, renameSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Verify SHA256 checksum of data against a checksum file line */
export function verifyChecksum(data: Uint8Array, checksumLine: string): boolean {
  const expected = checksumLine.trim().split(/\s+/)[0];
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const actual = hasher.digest("hex");
  return actual === expected;
}

export async function run(_args: string[]) {
  console.log("Checking for updates...");

  let release;
  try {
    release = await fetchLatestVersion();
  } catch (err: any) {
    console.error(`${pc.red("Failed to check for updates:")} ${err.message}`);
    process.exit(1);
  }

  if (release.version === GROVE_VERSION) {
    console.log(`Already on latest version (${pc.green("v" + GROVE_VERSION)})`);
    return;
  }

  console.log(`Downloading Grove ${pc.green("v" + release.version)}...`);

  // Download tarball
  let tarballBytes: Uint8Array;
  try {
    const resp = await fetch(release.tarballUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    tarballBytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err: any) {
    console.error(`${pc.red("Download failed:")} ${err.message}`);
    process.exit(1);
  }

  // Download and verify checksum
  try {
    const resp = await fetch(release.checksumUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const checksumLine = await resp.text();

    if (!verifyChecksum(tarballBytes, checksumLine)) {
      console.error(`${pc.red("Checksum verification failed.")} The download may be corrupted.`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`${pc.red("Checksum verification failed:")} ${err.message}`);
    process.exit(1);
  }

  // Extract to temp dir
  const tempDir = mkdtempSync(join(tmpdir(), "grove-upgrade-"));
  const tarballPath = join(tempDir, "grove.tar.gz");
  writeFileSync(tarballPath, tarballBytes);

  const tar = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", tempDir]);
  if (tar.exitCode !== 0) {
    console.error(`${pc.red("Failed to extract archive:")} ${tar.stderr.toString()}`);
    process.exit(1);
  }

  const newBinary = join(tempDir, "grove");
  const currentBinary = process.execPath;

  // Replace binary
  try {
    try {
      unlinkSync(currentBinary);
      renameSync(newBinary, currentBinary);
    } catch (err: any) {
      if (err.code === "EXDEV") {
        copyFileSync(newBinary, currentBinary);
      } else {
        throw err;
      }
    }
    chmodSync(currentBinary, 0o755);
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      console.error(`${pc.red("Permission denied.")} Try: ${pc.bold("sudo grove upgrade")}`);
    } else {
      console.error(`${pc.red("Failed to replace binary:")} ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`${pc.green("✓")} Upgraded grove from v${GROVE_VERSION} to ${pc.bold("v" + release.version)}`);
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/cli/upgrade.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/upgrade.ts tests/cli/upgrade.test.ts
git commit -m "feat: add grove upgrade command (#35)"
```

---

### Task 4: Register command and wire update check

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/up.ts`

- [ ] **Step 1: Add `upgrade` to command router in `src/cli/index.ts`**

Add after the `help` entry in the commands object:

```ts
upgrade: () => import("./commands/upgrade"),
```

Also add to the `printUsage()` help text, after the `help` line:

```ts
  ${pc.green("upgrade")}   Upgrade to latest version
```

- [ ] **Step 2: Add update check to `src/cli/commands/up.ts`**

Add import at top:

```ts
import { checkForUpdate } from "../update-check";
```

After the "Press Ctrl+C to stop." line (line 41), add:

```ts
    // Fire-and-forget update check
    checkForUpdate();
```

- [ ] **Step 3: Run all tests**

```bash
bun test tests/
```

Expected: all tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts src/cli/commands/up.ts
git commit -m "feat: register upgrade command, wire update check to grove up (#35)"
```

---

### Task 5: End-to-end verification and PR

- [ ] **Step 1: Run all tests**

```bash
bun test tests/
```

Expected: all tests pass.

- [ ] **Step 2: Verify full build works**

```bash
bun run build
```

Expected: builds successfully.

- [ ] **Step 3: Verify binary shows upgrade in help**

```bash
./bin/grove --help
```

Expected: `upgrade` listed in commands.

- [ ] **Step 4: Verify upgrade command runs**

```bash
./bin/grove upgrade
```

Expected: either "Already on latest version" or attempts to download (may fail if no release exists yet — that's fine, verify it prints the checking message and handles the error gracefully).

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin peter/grove-upgrade
gh pr create --title "feat: grove upgrade + update check (#35)" --body "Closes #35

## Summary
- \`grove upgrade\` command: downloads latest binary from GitHub Releases, verifies SHA256, replaces in-place
- Update check on \`grove up\`: non-blocking, cached 24h, skips in CI/non-TTY
- \`GROVE_NO_UPDATE_CHECK=1\` to disable
- Supports darwin-arm64, darwin-x64, linux-x64

## Test plan
- [x] Unit tests for platform detection, GitHub API fetch, cached check, checksum verification
- [ ] Manual: \`grove upgrade\` after a release is published
- [ ] Manual: \`grove up\` shows update notice when newer version exists

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
