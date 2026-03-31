# Upgrading

## Self-Update

Grove can update itself in place:

```bash
grove upgrade
```

This:
1. Checks GitHub Releases for the latest version
2. Downloads the platform-specific binary
3. Verifies SHA256 checksum
4. Replaces the current binary

If you get a permission error:

```bash
sudo grove upgrade
```

## Update Checks

On every `grove up`, Grove checks for newer versions in the background (non-blocking). If one exists, you'll see:

```
  Grove v0.2.0 available. Run 'grove upgrade' to update.
```

The check is cached for 24 hours at `~/.grove/update-check.json`.

### Disabling Update Checks

Set the environment variable:

```bash
export GROVE_NO_UPDATE_CHECK=1
```

Update checks are also skipped automatically in non-TTY environments (CI pipelines, scripts).

## Manual Update (from source)

If you built from source:

```bash
cd grove
git pull
bun install
cd web && bun install && cd ..
bun run build
```

## Supported Platforms

| Platform | Architecture | Binary |
|----------|-------------|--------|
| macOS | Apple Silicon (arm64) | `grove-darwin-arm64` |
| macOS | Intel (x64) | `grove-darwin-x64` |
| Linux | x64 | `grove-linux-x64` |
| Windows | x64 | `grove-windows-x64` |

Windows binary is available but Windows runtime support is experimental.

## Config Migration

When upgrading between major versions, run:

```bash
grove config migrate
```

This updates `grove.yaml` to the latest schema, preserving your settings and adding new defaults.
