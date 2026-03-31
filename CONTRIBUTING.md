# Contributing to Grove

Thanks for your interest in Grove! This guide covers everything you need to get started contributing.

## Getting Started

### Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **[Bun](https://bun.sh/)** >= 1.0 | Yes | `curl -fsSL https://bun.sh/install \| bash` |
| **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** | For runtime | `npm install -g @anthropic-ai/claude-code` |
| **git** | Yes | Usually pre-installed |
| **[gh](https://cli.github.com/)** | Recommended | `brew install gh` / `apt install gh` |

### Setup

```bash
git clone https://github.com/bpamiri/grove.git
cd grove
bun install
bun run test          # 517 tests, should all pass
bun run dev -- help   # Run from source
```

### Project Structure

```
src/
├── broker/       # HTTP+WS server, SQLite state, event bus
├── cli/          # CLI commands (grove up, grove tasks, etc.)
├── engine/       # Step engine, pipeline execution
├── merge/        # PR creation, CI watching, merge queue
├── notifications/ # Slack, webhook, system notifications
├── shared/       # Types, protocol, utilities
├── tunnel/       # Cloudflare tunnel management
└── web/          # React frontend (Vite + Tailwind)
tests/            # Mirrors src/ structure
```

## How to Contribute

### Reporting Bugs

[Open an issue](https://github.com/bpamiri/grove/issues/new) with:
- What you expected vs what happened
- Steps to reproduce
- Grove version (`grove --version`)
- OS and shell

### Suggesting Features

Start a thread in [Ideas discussions](https://github.com/bpamiri/grove/discussions/categories/ideas). Describe the problem you're solving, not just the solution. This lets us explore alternatives before committing to an approach.

### Asking Questions

Use [Q&A discussions](https://github.com/bpamiri/grove/discussions/categories/q-a). No question is too basic.

### Submitting Code

1. **Check for existing work** — search issues and discussions first
2. **Open an issue** for anything non-trivial so we can discuss the approach
3. **Fork and branch** — branch names: `yourname/short-description`
4. **Write tests** — Grove has 500+ tests. New features need tests; bug fixes need a regression test.
5. **Keep PRs focused** — one feature or fix per PR. Smaller PRs get reviewed faster.
6. **Open the PR** against `main`

### Good First Contributions

Look for issues labeled [`good first issue`](https://github.com/bpamiri/grove/labels/good%20first%20issue). These are scoped, well-defined tasks suitable for newcomers.

Other ways to contribute without touching core code:
- Improve documentation
- Add examples or guides
- Report bugs with clear reproduction steps
- Answer questions in Discussions

## Development Workflow

### Running Tests

```bash
bun run test              # All tests
bun test tests/broker/    # Tests in a directory
bun test --watch          # Watch mode
```

Tests are co-located with source in a parallel `tests/` directory. Test files follow the pattern `tests/<module>/<name>.test.ts`.

### Building

```bash
bun run build             # Build binary + frontend
bun run dev -- <command>  # Run from source without building
```

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add batch planner dependency analysis
fix: sync YAML config when rescan detects null remote
test: add API-level tests for tree rescan
docs: add design spec for worktree cleanup
chore: update dependencies
```

### Code Style

- TypeScript strict mode
- No unnecessary abstractions — three similar lines beat a premature helper
- Follow existing patterns in the module you're editing
- Tests verify behavior, not implementation details

## Architecture Overview

Grove separates **infrastructure** from **intelligence**:

- **Broker** — Bun HTTP+WS server managing state (SQLite), events, plugins, adapters, tunnel, and the merge queue. Stable, lightweight, never makes AI decisions.
- **Orchestrator** — Persistent Claude Code session you chat with to plan and delegate work.
- **Workers** — Ephemeral agent sessions in isolated git worktrees. Configurable via adapters (Claude Code, Codex, Aider, Gemini).
- **Evaluator** — Quality gates (tests, lint, diff size) run on worker output in-process.

Tasks flow through configurable pipelines (paths): plan → implement → evaluate → merge. Each step can succeed, fail, or retry.

For deeper details, see [Architecture Guide](docs/guides/architecture.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
