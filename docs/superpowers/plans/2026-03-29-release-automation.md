# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate versioning, changelog generation, cross-platform binary builds, and GitHub Release creation via a manual-dispatch workflow.

**Architecture:** A `workflow_dispatch`-triggered `release.yml` orchestrates three jobs: version-bump (changelogen + sync script), build (native matrix), and release (GitHub Release with tarballs + checksums). The existing `build.yml` is trimmed to CI-only.

**Tech Stack:** changelogen, Bun, GitHub Actions, `softprops/action-gh-release@v2`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/sync-version.ts` | Create | Read version from package.json, patch GROVE_VERSION in types.ts |
| `package.json` | Modify | Add changelogen dev dependency |
| `.github/workflows/release.yml` | Create | Manual-dispatch release workflow (version-bump → build → release) |
| `.github/workflows/build.yml` | Modify | Remove release job, add missing embed step |

---

### Task 1: Version sync script

**Files:**
- Create: `scripts/sync-version.ts`
- Reference: `src/shared/types.ts:294`, `package.json:2`

- [ ] **Step 1: Write `scripts/sync-version.ts`**

```ts
#!/usr/bin/env bun
// Syncs GROVE_VERSION in src/shared/types.ts with the version in package.json.
// Called during the release workflow after changelogen bumps package.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;

const typesPath = join(ROOT, "src/shared/types.ts");
const content = readFileSync(typesPath, "utf-8");

const updated = content.replace(
  /export const GROVE_VERSION = ".*";/,
  `export const GROVE_VERSION = "${version}";`
);

if (updated === content) {
  console.error("ERROR: GROVE_VERSION line not found in types.ts");
  process.exit(1);
}

writeFileSync(typesPath, updated);
console.log(`Synced GROVE_VERSION to ${version}`);
```

- [ ] **Step 2: Verify the script works**

Run:
```bash
bun run scripts/sync-version.ts
```

Expected: `Synced GROVE_VERSION to 3.0.0-alpha.0` (no change since versions already match).

Verify the file is unchanged:
```bash
git diff src/shared/types.ts
```

Expected: no diff (version already matches).

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-version.ts
git commit -m "feat: add version sync script (#36)"
```

---

### Task 2: Add changelogen dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install changelogen**

```bash
bun add -d changelogen
```

- [ ] **Step 2: Verify it installed**

```bash
bunx changelogen --help
```

Expected: shows changelogen help output with available flags.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add changelogen dev dependency (#36)"
```

---

### Task 3: Create `release.yml` workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the release workflow**

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump type'
        type: choice
        options:
          - patch
          - minor
          - major
        default: patch

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  version-bump:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      tag: ${{ steps.version.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump version with changelogen
        run: npx changelogen --release --no-push --${{ inputs.bump }}

      - name: Sync GROVE_VERSION
        run: bun run scripts/sync-version.ts

      - name: Amend release commit with synced types.ts
        run: |
          git add src/shared/types.ts
          git commit --amend --no-edit

      - name: Extract version
        id: version
        run: |
          version=$(node -p "require('./package.json').version")
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "tag=v$version" >> "$GITHUB_OUTPUT"

      - name: Push commit and tag
        run: |
          git push origin main
          git push origin "v${{ steps.version.outputs.version }}"

  build:
    needs: version-bump
    strategy:
      matrix:
        include:
          - runner: macos-14
            artifact: grove-darwin-arm64
          - runner: macos-13
            artifact: grove-darwin-x64
          - runner: ubuntu-latest
            artifact: grove-linux-x64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.version-bump.outputs.tag }}

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: |
          bun install
          cd web && bun install

      - name: Build web assets
        run: bun run build:web

      - name: Embed web assets
        run: bun run build:embed

      - name: Build binary
        run: |
          mkdir -p bin
          bun build src/cli/index.ts --compile --outfile bin/grove

      - name: Package tarball and checksum
        run: |
          tar -czf ${{ matrix.artifact }}.tar.gz -C bin grove
          shasum -a 256 ${{ matrix.artifact }}.tar.gz > ${{ matrix.artifact }}.tar.gz.sha256

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: |
            ${{ matrix.artifact }}.tar.gz
            ${{ matrix.artifact }}.tar.gz.sha256

  release:
    needs: [version-bump, build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Collect release assets
        run: |
          mkdir -p release
          find artifacts -type f \( -name '*.tar.gz' -o -name '*.sha256' \) -exec cp {} release/ \;

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.version-bump.outputs.tag }}
          name: Grove ${{ needs.version-bump.outputs.tag }}
          generate_release_notes: true
          files: release/*
```

- [ ] **Step 2: Validate the YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add manual-dispatch release workflow (#36)"
```

---

### Task 4: Trim `build.yml` to CI-only

**Files:**
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Remove the `release` job and add `build:embed` step**

The updated `build.yml` should be:

```yaml
name: Build

on:
  push:
    branches: [main]

concurrency:
  group: build-main
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: |
          bun install
          cd web && bun install

      - name: Run tests
        run: bun test tests/

  build:
    needs: test
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - target: bun-linux-x64
            artifact: grove-linux-x64
          - target: bun-darwin-arm64
            artifact: grove-darwin-arm64
          - target: bun-darwin-x64
            artifact: grove-darwin-x64
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: |
          bun install
          cd web && bun install

      - name: Build web assets
        run: bun run build:web

      - name: Embed web assets
        run: bun run build:embed

      - name: Build binary (${{ matrix.target }})
        run: |
          mkdir -p bin
          bun build src/cli/index.ts --compile --target=${{ matrix.target }} --outfile bin/grove

      - name: Upload binary
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: bin/grove
```

- [ ] **Step 2: Validate the YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "fix: remove release job from build.yml, add embed step (#36)"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Verify all tests pass**

```bash
bun test tests/
```

Expected: all tests pass.

- [ ] **Step 2: Verify full local build works**

```bash
bun run build
```

Expected: builds web assets, embeds them, compiles binary to `bin/grove`.

- [ ] **Step 3: Verify binary reports correct version**

```bash
./bin/grove --version
```

Expected: `grove 3.0.0-alpha.0`

- [ ] **Step 4: Verify sync script works with a fake version**

```bash
# Temporarily change version to test sync
node -e "const p=require('./package.json'); p.version='9.9.9'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)+'\n')"
bun run scripts/sync-version.ts
grep 'GROVE_VERSION' src/shared/types.ts
```

Expected: `export const GROVE_VERSION = "9.9.9";`

```bash
# Revert
git checkout -- package.json src/shared/types.ts
```

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin peter/release-automation
gh pr create --title "feat: release automation (#36)" --body "Closes #36

## Summary
- Add changelogen + manual-dispatch release workflow
- Version sync script keeps GROVE_VERSION in types.ts in sync with package.json
- build.yml trimmed to CI-only, missing embed step fixed
- release.yml: version-bump → native matrix build → GitHub Release with tarballs + checksums

## Test plan
- [ ] Verify \`bun run build\` succeeds on main
- [ ] Trigger release workflow manually with \`patch\` bump
- [ ] Verify GitHub Release has 3 tarballs + checksums
- [ ] Verify GROVE_VERSION matches package.json after release"
```
