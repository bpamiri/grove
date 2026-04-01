# Installation

## Prerequisites

| Tool | Required | macOS / Linux | Windows |
|------|----------|---------------|---------|
| **Bun** >= 1.0 | Yes | `curl -fsSL https://bun.sh/install \| bash` | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` | `npm install -g @anthropic-ai/claude-code` |
| **git** | Yes | Usually pre-installed | [Git for Windows](https://git-scm.com/download/win) |
| **gh** | No | `brew install gh` / `apt install gh` | `winget install GitHub.cli` |
| **cloudflared** | No | `brew install cloudflare/cloudflare/cloudflared` | `winget install Cloudflare.cloudflared` |

> **Optional:** Install additional agent CLIs ([Codex](https://github.com/openai/codex), [Aider](https://aider.chat/), [Gemini CLI](https://github.com/google-gemini/gemini-cli)) for multi-agent support via adapters.

## Install from Binary (recommended)

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/bpamiri/grove/releases/latest/download/grove-darwin-arm64.tar.gz | tar xz
chmod +x grove
sudo mv grove /usr/local/bin/

# macOS (Intel)
curl -fsSL https://github.com/bpamiri/grove/releases/latest/download/grove-darwin-x64.tar.gz | tar xz
chmod +x grove
sudo mv grove /usr/local/bin/

# Linux (x64)
curl -fsSL https://github.com/bpamiri/grove/releases/latest/download/grove-linux-x64.tar.gz | tar xz
chmod +x grove
sudo mv grove /usr/local/bin/
```

```powershell
# Windows (x64) — PowerShell
Invoke-WebRequest -Uri "https://github.com/bpamiri/grove/releases/latest/download/grove-windows-x64.tar.gz" -OutFile grove.tar.gz
tar xzf grove.tar.gz
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\grove" | Out-Null
Move-Item grove.exe "$env:LOCALAPPDATA\grove\grove.exe" -Force
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA\grove", "User")
```

> **Windows note:** After adding to PATH, restart your terminal for the change to take effect.

Verify: `grove --version`

## Build from Source

```bash
git clone https://github.com/bpamiri/grove.git
cd grove
bun install
cd web && bun install && cd ..
bun run build
```

This produces `bin/grove`. Optionally symlink it:

```bash
ln -s $(pwd)/bin/grove /usr/local/bin/grove
```

On Windows, add the `bin` directory to your PATH instead of symlinking:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$(Get-Location)\bin", "User")
```

## Run from Source (development)

No build step needed:

```bash
bun run dev -- help
```

## Verify Installation

```bash
grove --version    # Should print: grove 0.1.26
grove help         # Shows all commands
```

## Next Steps

[Quick Start](quick-start.md)
