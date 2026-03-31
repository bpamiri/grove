# T5: Multi-Agent Adapter Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Claude Code-specific logic into an adapter, define an abstract adapter interface, and add stub adapters for Codex CLI, Aider, and Gemini CLI. Per-task adapter selection via config or task field.

**Architecture:** An `AgentAdapter` interface defines spawn/resume/parse/cost methods. The Claude Code adapter extracts existing logic from worker.ts and orchestrator.ts. Other adapters are functional stubs (spawn command correct, output parsing basic). An `AdapterRegistry` auto-detects available CLIs and provides the adapter for a given task.

**Tech Stack:** Bun, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T5 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/agents/adapters/types.ts` | Adapter interface + types |
| Create | `src/agents/adapters/registry.ts` | Adapter registry with auto-detection |
| Create | `src/agents/adapters/claude-code.ts` | Claude Code adapter (extract from worker/orchestrator) |
| Create | `src/agents/adapters/codex-cli.ts` | Codex CLI adapter stub |
| Create | `src/agents/adapters/aider.ts` | Aider adapter stub |
| Create | `src/agents/adapters/gemini-cli.ts` | Gemini CLI adapter stub |
| Create | `tests/agents/adapters/registry.test.ts` | Registry + adapter tests |
| Modify | `src/agents/worker.ts` | Use adapter from registry |
| Modify | `src/shared/types.ts` | Add `adapter` to Task, `default_adapter` to SettingsConfig |
| Modify | `src/broker/schema-sql.ts` | Add `adapter TEXT` column |
| Modify | `src/broker/index.ts` | Initialize registry, detect adapters |
| Modify | `src/broker/server.ts` | Add GET /api/adapters endpoint |

---

### Task 1: Adapter Interface + Types

**Files:** Create `src/agents/adapters/types.ts`

- [ ] **Step 1: Create adapter types**

```typescript
// Grove v3 — Agent adapter interface
// Abstracts CLI-specific spawn/parse logic so Grove can use multiple AI agent CLIs.

export interface AgentAdapter {
  readonly name: string;
  readonly supportsResume: boolean;

  /** Check if the CLI binary is available on PATH */
  isAvailable(): boolean;

  /** Spawn a one-shot agent process */
  spawn(opts: SpawnOpts): SpawnResult;

  /** Resume an existing session (only if supportsResume is true) */
  resumeSession?(opts: ResumeOpts): SpawnResult;

  /** Parse a stdout line into a normalized activity event, or null */
  parseOutputLine(line: string): ParsedActivity | null;

  /** Extract final cost from a completed log file */
  parseCost(logPath: string): CostResult;
}

export interface SpawnOpts {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
  systemPrompt?: string;
  sessionId?: string;
  additionalArgs?: string[];
  additionalDirs?: string[];
}

export interface ResumeOpts {
  message: string;
  sessionId: string;
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
}

export interface SpawnResult {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
}

export interface ParsedActivity {
  kind: "tool_use" | "thinking" | "text" | "cost" | "result";
  tool?: string;
  input?: string;
  snippet?: string;
  content?: string;
  costUsd?: number;
  tokens?: number;
  exitCode?: number;
}

export interface CostResult {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/adapters/types.ts
git commit -m "feat: add agent adapter interface and types"
```

---

### Task 2: Claude Code Adapter + Registry

**Files:** Create `src/agents/adapters/claude-code.ts`, `src/agents/adapters/registry.ts`, `tests/agents/adapters/registry.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/agents/adapters/registry.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { AdapterRegistry } from "../../../src/agents/adapters/registry";
import { ClaudeCodeAdapter } from "../../../src/agents/adapters/claude-code";

describe("AdapterRegistry", () => {
  test("registers and retrieves adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeCodeAdapter();
    registry.register(adapter);
    expect(registry.get("claude-code")).toBe(adapter);
  });

  test("returns undefined for unknown adapter", () => {
    const registry = new AdapterRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("getDefault returns first registered adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeCodeAdapter();
    registry.register(adapter);
    expect(registry.getDefault()).toBe(adapter);
  });

  test("listAll returns all registered adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(new ClaudeCodeAdapter());
    const all = registry.listAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe("claude-code");
  });
});

describe("ClaudeCodeAdapter", () => {
  test("name is claude-code", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.name).toBe("claude-code");
  });

  test("supportsResume is true", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.supportsResume).toBe(true);
  });

  test("parseOutputLine extracts tool_use from stream-json", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tool_use");
    expect(result!.tool).toBe("Read");
    expect(result!.input).toBe("src/a.ts");
  });

  test("parseOutputLine extracts thinking", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Analyzing the code..." }] },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("thinking");
    expect(result!.snippet).toBe("Analyzing the code...");
  });

  test("parseOutputLine extracts cost from result", () => {
    const adapter = new ClaudeCodeAdapter();
    const line = JSON.stringify({
      type: "result", cost_usd: 0.05, usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const result = adapter.parseOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("cost");
    expect(result!.costUsd).toBe(0.05);
    expect(result!.tokens).toBe(1500);
  });

  test("parseOutputLine returns null for unparseable lines", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.parseOutputLine("not json")).toBeNull();
    expect(adapter.parseOutputLine("{}")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement ClaudeCodeAdapter**

Create `src/agents/adapters/claude-code.ts`:

```typescript
// Grove v3 — Claude Code adapter
import { readFileSync } from "node:fs";
import type { AgentAdapter, SpawnOpts, ResumeOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  readonly supportsResume = true;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "claude"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const args = ["claude", "-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }
    for (const dir of opts.additionalDirs ?? []) {
      args.push("--add-dir", dir);
    }
    args.push("--dangerously-skip-permissions");
    args.push(...(opts.additionalArgs ?? []));

    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc, pid: proc.pid };
  }

  resumeSession(opts: ResumeOpts): SpawnResult {
    const args = ["claude", "-p", opts.message, "--output-format", "stream-json", "--verbose", "--resume", opts.sessionId];

    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return null; }

    if (obj.type === "assistant") {
      for (const block of obj.message?.content ?? []) {
        if (block.type === "tool_use") {
          const tool = block.name ?? "tool";
          const input = block.input ?? {};
          const file = (input.file_path ?? input.command ?? input.pattern ?? "").toString().slice(0, 500);
          return { kind: "tool_use", tool, input: file };
        }
        if (block.type === "thinking" && block.thinking) {
          return { kind: "thinking", snippet: block.thinking.slice(0, 300).replace(/\n/g, " ") };
        }
        if (block.type === "text" && block.text && block.text.length > 10) {
          return { kind: "text", content: block.text.slice(0, 300).replace(/\n/g, " ") };
        }
      }
    }

    if (obj.type === "result" && obj.cost_usd != null) {
      return {
        kind: "cost",
        costUsd: Number(obj.cost_usd),
        tokens: Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0),
      };
    }

    return null;
  }

  parseCost(logPath: string): CostResult {
    try {
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "result" && obj.cost_usd != null) {
            return {
              costUsd: Number(obj.cost_usd),
              inputTokens: Number(obj.usage?.input_tokens ?? 0),
              outputTokens: Number(obj.usage?.output_tokens ?? 0),
            };
          }
        } catch {}
      }
    } catch {}
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
```

- [ ] **Step 3: Implement AdapterRegistry**

Create `src/agents/adapters/registry.ts`:

```typescript
// Grove v3 — Agent adapter registry
import type { AgentAdapter } from "./types";

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private defaultName: string | null = null;

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
    if (!this.defaultName) this.defaultName = adapter.name;
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getDefault(): AgentAdapter {
    const adapter = this.defaultName ? this.adapters.get(this.defaultName) : undefined;
    if (!adapter) throw new Error("No adapters registered");
    return adapter;
  }

  setDefault(name: string): void {
    if (!this.adapters.has(name)) throw new Error(`Adapter "${name}" not registered`);
    this.defaultName = name;
  }

  listAll(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Auto-detect which adapters have their CLI available on PATH */
  detectAvailable(): string[] {
    return this.listAll().filter(a => a.isAvailable()).map(a => a.name);
  }
}
```

- [ ] **Step 4: Create stub adapters**

Create `src/agents/adapters/codex-cli.ts`:

```typescript
// Grove v3 — Codex CLI adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class CodexCliAdapter implements AgentAdapter {
  readonly name = "codex-cli";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "codex"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["codex", "-q", "--json", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message") return { kind: "text", content: obj.content?.slice(0, 300) };
      if (obj.type === "tool_call") return { kind: "tool_use", tool: obj.name, input: obj.arguments?.slice(0, 500) };
    } catch {}
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
```

Create `src/agents/adapters/aider.ts`:

```typescript
// Grove v3 — Aider adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class AiderAdapter implements AgentAdapter {
  readonly name = "aider";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "aider"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["aider", "--yes-always", "--no-git", "--message", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    if (line.includes("Applied edit to")) return { kind: "tool_use", tool: "Edit", input: line.split("Applied edit to ")[1] };
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
```

Create `src/agents/adapters/gemini-cli.ts`:

```typescript
// Grove v3 — Gemini CLI adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = "gemini-cli";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "gemini"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["gemini", "-p", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "text") return { kind: "text", content: obj.text?.slice(0, 300) };
    } catch {}
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/agents/adapters/registry.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/adapters/ tests/agents/adapters/
git commit -m "feat: add adapter registry, Claude Code adapter, and stub adapters"
```

---

### Task 3: Schema + Types + Broker Wiring

**Files:** Modify `src/shared/types.ts`, `src/broker/schema-sql.ts`, `src/broker/index.ts`, `src/broker/server.ts`

- [ ] **Step 1: Add adapter field to Task and SettingsConfig**

In `src/shared/types.ts`, add to Task interface (after `source_pr`):
```typescript
  adapter: string | null;
```

Add to SettingsConfig (after `max_retries`):
```typescript
  default_adapter?: string;
```

- [ ] **Step 2: Add adapter column to schema**

In `src/broker/schema-sql.ts`, add after the `source_pr INTEGER` line in the tasks table:
```sql
  adapter TEXT DEFAULT 'claude-code'
```

- [ ] **Step 3: Initialize registry in broker**

In `src/broker/index.ts`, add imports:
```typescript
import { AdapterRegistry } from "../agents/adapters/registry";
import { ClaudeCodeAdapter } from "../agents/adapters/claude-code";
import { CodexCliAdapter } from "../agents/adapters/codex-cli";
import { AiderAdapter } from "../agents/adapters/aider";
import { GeminiCliAdapter } from "../agents/adapters/gemini-cli";
```

Add module variable:
```typescript
let adapterRegistry: AdapterRegistry | null = null;
```

In `startBroker()`, after plugin init, add:
```typescript
  // Initialize adapter registry
  adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(new ClaudeCodeAdapter());
  adapterRegistry.register(new CodexCliAdapter());
  adapterRegistry.register(new AiderAdapter());
  adapterRegistry.register(new GeminiCliAdapter());
  const defaultAdapter = config.settings.default_adapter ?? "claude-code";
  try { adapterRegistry.setDefault(defaultAdapter); } catch {}
  const available = adapterRegistry.detectAvailable();
  if (available.length > 0) console.log(`  Adapters: ${available.join(", ")}`);
```

Export getter:
```typescript
export function getAdapterRegistry(): AdapterRegistry | null {
  return adapterRegistry;
}
```

- [ ] **Step 4: Add API endpoint**

In `src/broker/server.ts`, add import:
```typescript
import { getAdapterRegistry } from "./index";
```

Add endpoint in handleApi before the fallback 404:
```typescript
    // GET /api/adapters — list available adapters
    if (path === "/api/adapters" && req.method === "GET") {
      const registry = getAdapterRegistry();
      const adapters = registry?.listAll().map(a => ({
        name: a.name,
        available: a.isAvailable(),
        supportsResume: a.supportsResume,
      })) ?? [];
      return json(adapters);
    }
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/broker/schema-sql.ts src/broker/index.ts src/broker/server.ts
git commit -m "feat: wire adapter registry into broker with schema and API endpoint"
```

---

### Task 4: Use Adapter in Worker (non-breaking refactor)

**Files:** Modify `src/agents/worker.ts`

- [ ] **Step 1: Use adapter for spawning but keep existing behavior**

In `src/agents/worker.ts`, add imports:
```typescript
import { getAdapterRegistry } from "../broker/index";
```

In `spawnWorker()`, replace the direct Bun.spawn block with adapter usage. Find the block that spawns claude (around line 85-97):

Replace:
```typescript
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    {
      cwd: worktreePath,
      env: {
        ...process.env,
        GROVE_TASK_ID: task.id,
        GROVE_WORKTREE_PATH: worktreePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
```

With:
```typescript
  // Resolve adapter: task → tree → global default
  const treeAdapter = treeConfig.adapter;
  const taskAdapter = (task as any).adapter;
  const adapterName = taskAdapter ?? treeAdapter ?? "claude-code";
  const registry = getAdapterRegistry();
  const adapter = registry?.get(adapterName) ?? registry?.getDefault();

  if (!adapter) {
    throw new Error(`No adapter available (requested: ${adapterName})`);
  }

  const { proc, pid: spawnedPid } = adapter.spawn({
    prompt,
    cwd: worktreePath,
    env: { GROVE_TASK_ID: task.id, GROVE_WORKTREE_PATH: worktreePath },
    logPath,
  });
```

Update the `pid` reference — replace `const pid = proc.pid;` with `const pid = spawnedPid;` (or just use proc.pid as before since SpawnResult includes proc).

Note: The monitoring loop in `monitorWorker` still does its own stream-json parsing. That's fine — the adapter's `parseOutputLine` is available for future use but we don't need to wire it into monitoring now. The worker already emits SAP events correctly. This task just abstracts the spawn.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/agents/worker.ts
git commit -m "feat: use adapter registry for worker spawning"
```
