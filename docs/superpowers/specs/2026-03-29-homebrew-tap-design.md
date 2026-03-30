# Homebrew Tap: bpamiri/homebrew-grove

**Issue:** #37
**Date:** 2026-03-29
**Status:** Approved

## Overview

Enable `brew install bpamiri/grove/grove` for macOS and Linux users. Auto-update the formula when new releases are published via the existing release workflow.

## Components

### 1. `bpamiri/homebrew-grove` repo (already created)

Contains `Formula/grove.rb` — a multi-platform Homebrew formula using `on_macos`/`on_linux` blocks with architecture detection.

The formula:
- Downloads the platform-specific pre-compiled binary tarball from GitHub Releases
- Uses `Hardware::CPU.arm?` to select arm64 vs x64 on macOS
- Installs the `grove` binary to Homebrew's `bin/`
- Includes a test block that verifies `grove --version` runs

### 2. Auto-bump job in `release.yml`

New `update-homebrew` job added after the `release` job in `.github/workflows/release.yml`.

Steps:
1. Clone `bpamiri/homebrew-grove` using `RELEASE_PAT`
2. Download the `.sha256` checksum files from the just-created release
3. Generate `Formula/grove.rb` from inline template with:
   - New version string (from `version-bump` job output)
   - SHA256 checksums for all 3 platform tarballs (darwin-arm64, darwin-x64, linux-x64)
   - Download URLs using the new tag
4. Commit and push to `homebrew-grove` main branch

No third-party actions — just shell scripting with `gh` and `git`.

## Formula Template

```ruby
class Grove < Formula
  desc "Conversational AI development orchestrator"
  homepage "https://github.com/bpamiri/grove"
  version "VERSION"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/bpamiri/grove/releases/download/vVERSION/grove-darwin-arm64.tar.gz"
      sha256 "SHA_DARWIN_ARM64"
    else
      url "https://github.com/bpamiri/grove/releases/download/vVERSION/grove-darwin-x64.tar.gz"
      sha256 "SHA_DARWIN_X64"
    end
  end

  on_linux do
    url "https://github.com/bpamiri/grove/releases/download/vVERSION/grove-linux-x64.tar.gz"
    sha256 "SHA_LINUX_X64"
  end

  def install
    bin.install "grove"
  end

  test do
    assert_match "grove", shell_output("#{bin}/grove --version")
  end
end
```

## User Experience

```bash
# First install
brew tap bpamiri/grove
brew install grove
grove --version

# Future upgrades
brew upgrade grove
```

## Files

| File | Repo | Action |
|------|------|--------|
| `Formula/grove.rb` | `bpamiri/homebrew-grove` | Create — Homebrew formula |
| `.github/workflows/release.yml` | `bpamiri/grove` | Modify — add update-homebrew job |

## Decisions

- **No `mislav/bump-homebrew-formula-action`:** That action is designed for single-URL formulas. Our multi-platform formula with `on_macos`/`on_linux` blocks needs custom template generation.
- **Direct push to homebrew-grove:** No PR needed — the tap repo is simple and the update is fully automated from a trusted source (the release workflow).
- **Checksums from `.sha256` files:** The release workflow already generates these. We download and parse them rather than recomputing.

## Acceptance Criteria

- [ ] `brew tap bpamiri/grove && brew install grove` installs the binary
- [ ] `grove --version` works after install
- [ ] Release workflow auto-updates the formula on new releases
- [ ] Formula works on Apple Silicon and Intel Macs
- [ ] Formula works on Linux (x64)
