# Grove Upgrade: Version Checking and Self-Update

**Issue:** #35
**Date:** 2026-03-29
**Status:** Approved

## Overview

Add version checking on `grove up` and a `grove upgrade` command that downloads and installs the latest binary from GitHub Releases. No version storage or rollback — simple in-place binary replacement.

## Release Flow (prerequisite)

This feature depends on the release automation from #36 being in place. GitHub Releases must contain platform-specific tarballs (`grove-darwin-arm64.tar.gz`, `grove-darwin-x64.tar.gz`, `grove-linux-x64.tar.gz`) with corresponding `.sha256` checksum files.

## Components

### 1. `src/cli/update-check.ts` (new)

Shared module with three functions:

#### `getPlatformAssetName(): string`
Maps `process.platform` + `process.arch` to the release asset name:
- `darwin` + `arm64` → `grove-darwin-arm64`
- `darwin` + `x64` → `grove-darwin-x64`
- `linux` + `x64` → `grove-linux-x64`
- Throws for unsupported platforms.

#### `fetchLatestVersion(): Promise<{ version: string; tarballUrl: string; checksumUrl: string }>`
- Fetches `https://api.github.com/repos/bpamiri/grove/releases/latest`
- Extracts `tag_name` (strips leading `v`), constructs download URLs using the predictable pattern: `https://github.com/bpamiri/grove/releases/download/v{version}/grove-{platform}.tar.gz`
- Returns version string + tarball URL + checksum URL.

#### `checkForUpdate(): Promise<void>`
The cached, silent check called by `grove up`:
- Returns immediately if `GROVE_NO_UPDATE_CHECK=1` or `!process.stdout.isTTY`
- Reads `~/.grove/update-check.json`. If `checked_at` is less than 24 hours ago, uses cached `latest_version`.
- Otherwise calls `fetchLatestVersion()` and writes cache.
- Compares `latest_version` to `GROVE_VERSION`. If newer, prints: `Grove v{latest} available. Run 'grove upgrade' to update.`
- Entire function wrapped in try/catch — any error is silently swallowed.

Cache file format:
```json
{
  "checked_at": "2026-03-29T12:00:00.000Z",
  "latest_version": "3.1.0"
}
```

Cache location: `~/.grove/update-check.json` (uses `GROVE_HOME` env var or `$HOME/.grove`).

### 2. `src/cli/commands/upgrade.ts` (new)

The `grove upgrade` command:

1. Print `Checking for updates...`
2. Call `fetchLatestVersion()` (always fresh, ignore cache)
3. Compare to `GROVE_VERSION`. If already on latest, print `Already on latest version (v{version})` and exit.
4. Print `Downloading Grove v{version}...`
5. Download tarball via `fetch(tarballUrl)` to a temp file
6. Download checksum file via `fetch(checksumUrl)`
7. Compute SHA256 of downloaded tarball using `Bun.CryptoHasher("sha256")`
8. Compare to checksum. If mismatch, print error and exit with code 1.
9. Extract binary from tarball: `tar -xzf {tarball} -C {tempDir}` via `Bun.spawnSync`
10. Get current binary path from `process.execPath`
11. Replace binary:
    - Try `rename(tempBinary, execPath)` (atomic on same filesystem)
    - If `EXDEV` error (cross-device): `copyFileSync` + `unlinkSync` temp
    - Set executable permissions: `chmodSync(execPath, 0o755)`
12. Print `Upgraded grove from v{old} to v{new}`

Error handling:
- Network errors: print user-friendly message, exit 1
- Checksum mismatch: print warning, do not install, exit 1
- Permission errors: suggest `sudo` or check file ownership, exit 1

### 3. `src/cli/index.ts` (modify)

Add `upgrade` to the command router:
```typescript
upgrade: () => import("./commands/upgrade"),
```

### 4. `src/cli/commands/up.ts` (modify)

After broker starts and URLs are printed, add non-blocking update check:
```typescript
checkForUpdate(); // fire-and-forget, no await
```

## Decisions

- **No version storage / rollback:** YAGNI. In-place replacement is sufficient. Versioned storage can be added when `grove rollback` is actually needed.
- **`grove up` only for passive check:** It's the natural "session start" moment. Checking on every command would add latency to quick operations.
- **GitHub API for version check, predictable URLs for download:** The API gives us the latest version number in one call. Downloads use the predictable URL pattern since the repo is public.
- **SHA256 verification:** Ensures binary integrity. The release workflow already generates checksum files.
- **Silent failure on update check:** Network issues, rate limits, or API changes should never block `grove up`.

## Acceptance Criteria

- [ ] `grove up` prints update notice when newer version exists (non-blocking)
- [ ] `grove upgrade` downloads and installs latest binary
- [ ] Version check cached for 24h at `~/.grove/update-check.json`
- [ ] `GROVE_NO_UPDATE_CHECK=1` disables check
- [ ] Non-TTY environments skip check
- [ ] SHA256 checksum verified before installation
- [ ] Works on macOS (arm64 + x64) and Linux (x64)
- [ ] Unsupported platforms get a clear error message

## Files

| File | Action |
|------|--------|
| `src/cli/update-check.ts` | Create — version check + platform detection |
| `src/cli/commands/upgrade.ts` | Create — self-update command |
| `src/cli/index.ts` | Modify — register `upgrade` command |
| `src/cli/commands/up.ts` | Modify — call `checkForUpdate()` after startup |
