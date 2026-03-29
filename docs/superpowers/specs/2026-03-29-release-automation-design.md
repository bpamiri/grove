# Release Automation: changelogen + CI workflow

**Issue:** #36
**Date:** 2026-03-29
**Status:** Approved

## Overview

Automate version bumping, changelog generation, cross-platform binary builds, and GitHub Release creation via a manual-dispatch GitHub Actions workflow. No local tooling required beyond conventional commits.

## Release Flow

```
GitHub Actions UI → Release → Run workflow → pick patch/minor/major
  → changelogen bumps package.json version
  → sync-version.ts patches GROVE_VERSION in types.ts
  → commits + tags vX.Y.Z on main
  → builds 3 native binaries (darwin-arm64, darwin-x64, linux-x64)
  → tarballs + SHA256 checksums
  → GitHub Release created with all assets
```

## Components

### 1. `release.yml` (new workflow)

**Trigger:** `workflow_dispatch` with bump type input.

```yaml
on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump type'
        type: choice
        options: [patch, minor, major]
        default: patch
```

**Jobs:**

#### version-bump (ubuntu-latest)
- Checkout main
- Setup bun, install deps + changelogen
- Run `npx changelogen --release --no-push --${{ inputs.bump }}` to bump package.json, generate CHANGELOG.md, commit, and tag
- Run `bun run scripts/sync-version.ts` to patch `src/shared/types.ts`
- Amend the changelogen commit to include the types.ts change
- Push commit + tag to main

#### build (needs: version-bump, matrix)
Three runners for native compilation:

| Runner | Target | Artifact |
|--------|--------|----------|
| `macos-14` | darwin-arm64 | `grove-darwin-arm64.tar.gz` |
| `macos-13` | darwin-x64 | `grove-darwin-x64.tar.gz` |
| `ubuntu-latest` | linux-x64 | `grove-linux-x64.tar.gz` |

Steps per platform:
1. Checkout the tagged commit
2. `bun install` + `cd web && bun install`
3. `bun run build:web`
4. `bun run build:embed`
5. `bun build src/cli/index.ts --compile --outfile bin/grove` (native, no --target needed)
6. `tar -czf grove-<platform>.tar.gz -C bin grove`
7. `shasum -a 256 grove-<platform>.tar.gz > grove-<platform>.tar.gz.sha256`
8. Upload tarball + checksum as artifacts

#### release (needs: build)
- Download all artifacts
- Create GitHub Release via `softprops/action-gh-release@v2`
- Upload all `.tar.gz` + `.sha256` files
- Auto-generate release notes from conventional commits

### 2. `scripts/sync-version.ts` (new file)

Reads version from `package.json`, patches the `GROVE_VERSION` export line in `src/shared/types.ts`. Used by the release workflow to keep the hardcoded version in sync.

### 3. `build.yml` (modified)

- Remove the existing `release` job — release creation moves to `release.yml`
- Add missing `build:embed` step between `build:web` and binary compilation
- Remains CI-only: test + build on every push to main

## Files

| File | Action |
|------|--------|
| `.github/workflows/release.yml` | Create — manual-dispatch release workflow |
| `.github/workflows/build.yml` | Modify — remove release job, fix embed step |
| `scripts/sync-version.ts` | Create — version sync script |
| `package.json` | Modify — add changelogen dev dependency |

## Decisions

- **Manual dispatch over tag-push trigger:** Keeps releases in the normal GitHub UI workflow. No local tooling needed.
- **Native runners over cross-compilation:** Each platform builds on its native OS. Avoids Bun cross-compilation edge cases.
- **Tarballs + SHA256:** Standard release practice. Users verify integrity before installing.
- **Version sync script over runtime read:** Compiled binaries can't read package.json at runtime. A build-time script keeps types.ts in sync deterministically.
- **Separate release.yml over extending build.yml:** Clean separation of CI (every push) vs release (intentional).

## Acceptance Criteria

- [ ] `workflow_dispatch` with bump type triggers the full release pipeline
- [ ] Changelogen bumps version in package.json and generates CHANGELOG.md
- [ ] GROVE_VERSION in types.ts matches package.json after sync
- [ ] Tag `vX.Y.Z` created and pushed to main
- [ ] GitHub Release created with 3 platform tarballs + checksums
- [ ] build.yml no longer creates releases, but still validates builds on main
