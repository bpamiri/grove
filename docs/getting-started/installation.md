# Installation

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **Bun** >= 1.0 | Yes | `curl -fsSL https://bun.sh/install \| bash` |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` (requires Anthropic subscription) |
| **git** | Yes | Usually pre-installed |
| **gh** | No | `brew install gh` / `apt install gh` |
| **cloudflared** | No | `brew install cloudflare/cloudflare/cloudflared` |

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

## Run from Source (development)

No build step needed:

```bash
bun run dev -- help
```

## Verify Installation

```bash
grove --version    # Should print: grove 0.1.1
grove help         # Shows all commands
```

## Next Steps

[Quick Start](quick-start.md)
