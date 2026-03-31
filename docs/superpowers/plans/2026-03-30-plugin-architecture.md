# T4: Plugin Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight plugin system with JSON manifests, JavaScript modules, and a hook-based execution model. Plugins live in `~/.grove/plugins/` and register handlers for lifecycle events (gates, step transitions, notifications, worker spawning).

**Architecture:** A `PluginHost` class discovers plugins from disk, loads their manifests, and executes hooks with timeout protection. Hooks are called at specific integration points in the evaluator, step engine, notification dispatcher, and worker. CLI commands and API endpoints manage plugin lifecycle.

**Tech Stack:** Bun, TypeScript, dynamic import for plugin modules

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T4 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/plugins/types.ts` | Plugin manifest, hook, config type definitions |
| Create | `src/plugins/host.ts` | Plugin host — load, hook execution, lifecycle |
| Create | `tests/plugins/host.test.ts` | Plugin host unit tests |
| Create | `src/cli/commands/plugins.ts` | CLI commands (list, enable, disable, config) |
| Modify | `src/agents/evaluator.ts` | Call gate hooks after built-in gates |
| Modify | `src/engine/step-engine.ts` | Call step:pre/step:post hooks |
| Modify | `src/notifications/dispatcher.ts` | Call notify:custom hooks |
| Modify | `src/broker/index.ts` | Initialize PluginHost on startup |
| Modify | `src/broker/server.ts` | Add /api/plugins endpoints |
| Modify | `src/cli/index.ts` | Register plugins subcommand |

---

### Task 1: Plugin Types

**Files:**
- Create: `src/plugins/types.ts`

- [ ] **Step 1: Create plugin type definitions**

Create `src/plugins/types.ts`:

```typescript
// Grove v3 — Plugin system type definitions

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks: Record<string, HookDefinition>;
  config?: Record<string, ConfigField>;
}

export interface HookDefinition {
  description: string;
  timeout?: number; // ms, default 60000
}

export interface ConfigField {
  type: "string" | "number" | "boolean";
  default: unknown;
  description: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;           // absolute path to plugin directory
  enabled: boolean;
  module: PluginModule | null;
}

export interface PluginModule {
  /** Called when plugin is loaded. Register hook handlers here. */
  activate?(context: PluginContext): void | Promise<void>;
  /** Called when plugin is unloaded. */
  deactivate?(): void | Promise<void>;
  /** Hook handlers keyed by hook name */
  hooks?: Record<string, HookHandler>;
}

export type HookHandler = (input: any) => any | Promise<any>;

export interface PluginContext {
  config: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  hooks: string[];
}

// Hook input/output types for specific hooks
export interface GateHookInput {
  taskId: string;
  worktreePath: string;
  treeId: string;
  treePath: string;
}

export interface GateHookResult {
  passed: boolean;
  message: string;
}

export interface StepPreHookInput {
  taskId: string;
  stepId: string;
  stepType: string;
  treeId: string;
}

export interface StepPreHookResult {
  proceed: boolean;
  reason?: string;
}

export interface StepPostHookInput {
  taskId: string;
  stepId: string;
  outcome: string;
  context?: string;
}

export interface NotifyHookInput {
  event: string;
  taskId?: string;
  summary: string;
  detail?: string;
}

export interface WorkerPreSpawnInput {
  taskId: string;
  treeId: string;
  prompt: string;
}

export interface WorkerPreSpawnResult {
  prompt?: string; // can modify the prompt
}
```

- [ ] **Step 2: Commit**

```bash
git add src/plugins/types.ts
git commit -m "feat: add plugin system type definitions"
```

---

### Task 2: Plugin Host

**Files:**
- Create: `src/plugins/host.ts`
- Create: `tests/plugins/host.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/plugins/host.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PluginHost } from "../../src/plugins/host";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const TEST_PLUGIN_DIR = join(import.meta.dir, "test-plugins");

beforeEach(() => {
  mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true });
});

function createTestPlugin(name: string, manifest: any, moduleCode?: string) {
  const dir = join(TEST_PLUGIN_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  if (moduleCode) {
    writeFileSync(join(dir, "index.js"), moduleCode);
  }
}

describe("PluginHost", () => {
  test("discovers plugins from directory", async () => {
    createTestPlugin("test-gate", {
      name: "test-gate",
      version: "1.0.0",
      description: "Test gate plugin",
      hooks: { "gate:custom": { description: "Test gate" } },
    });
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const plugins = host.list();
    expect(plugins.length).toBe(1);
    expect(plugins[0].name).toBe("test-gate");
    expect(plugins[0].hooks).toContain("gate:custom");
  });

  test("ignores directories without plugin.json", async () => {
    mkdirSync(join(TEST_PLUGIN_DIR, "not-a-plugin"), { recursive: true });
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    expect(host.list().length).toBe(0);
  });

  test("runHook returns empty array when no handlers", async () => {
    const host = new PluginHost();
    const results = await host.runHook("gate:custom", { taskId: "W-001" });
    expect(results).toEqual([]);
  });

  test("runHook executes handler and returns results", async () => {
    createTestPlugin("pass-gate", {
      name: "pass-gate",
      version: "1.0.0",
      description: "Always passes",
      hooks: { "gate:custom": { description: "Pass gate" } },
    }, `
      module.exports = {
        hooks: {
          "gate:custom": (input) => ({ passed: true, message: "Plugin gate passed" }),
        },
      };
    `);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const results = await host.runHook("gate:custom", { taskId: "W-001" });
    expect(results.length).toBe(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].message).toBe("Plugin gate passed");
  });

  test("runHook catches handler errors", async () => {
    createTestPlugin("bad-gate", {
      name: "bad-gate",
      version: "1.0.0",
      description: "Throws",
      hooks: { "gate:custom": { description: "Bad gate" } },
    }, `
      module.exports = {
        hooks: {
          "gate:custom": () => { throw new Error("plugin crash"); },
        },
      };
    `);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    // Should not throw
    const results = await host.runHook("gate:custom", { taskId: "W-001" });
    expect(results.length).toBe(0); // error result filtered out
  });

  test("enable/disable controls hook execution", async () => {
    createTestPlugin("toggle-gate", {
      name: "toggle-gate",
      version: "1.0.0",
      description: "Toggle test",
      hooks: { "gate:custom": { description: "Toggle gate" } },
    }, `
      module.exports = {
        hooks: {
          "gate:custom": () => ({ passed: true, message: "ran" }),
        },
      };
    `);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);

    host.disable("toggle-gate");
    let results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(0);

    host.enable("toggle-gate");
    results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(1);
  });

  test("runHook respects timeout", async () => {
    createTestPlugin("slow-gate", {
      name: "slow-gate",
      version: "1.0.0",
      description: "Slow",
      hooks: { "gate:custom": { description: "Slow gate", timeout: 50 } },
    }, `
      module.exports = {
        hooks: {
          "gate:custom": () => new Promise(r => setTimeout(r, 5000)),
        },
      };
    `);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(0); // timed out, no result
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/plugins/host.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PluginHost**

Create `src/plugins/host.ts`:

```typescript
// Grove v3 — Plugin host: discovery, loading, and hook execution
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { PluginManifest, LoadedPlugin, PluginModule, PluginInfo, PluginContext, HookHandler } from "./types";

const DEFAULT_TIMEOUT = 60_000;

export class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();

  /** Discover and load plugins from a directory */
  async loadAll(pluginDir: string): Promise<void> {
    if (!existsSync(pluginDir)) return;

    const entries = readdirSync(pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(pluginDir, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) continue;

      try {
        await this.load(entry.name, pluginDir);
      } catch (err) {
        console.error(`[plugins] Failed to load "${entry.name}":`, err);
      }
    }
  }

  /** Load a single plugin */
  async load(name: string, pluginDir: string): Promise<void> {
    const dir = join(pluginDir, name);
    const manifestPath = join(dir, "plugin.json");
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest: PluginManifest = JSON.parse(raw);

    let mod: PluginModule | null = null;
    const indexPath = join(dir, "index.js");
    if (existsSync(indexPath)) {
      try {
        mod = require(indexPath);
        if (mod?.activate) {
          const ctx: PluginContext = {
            config: this.getConfig(manifest.name),
            log: (msg: string) => console.log(`[plugin:${manifest.name}] ${msg}`),
          };
          await mod.activate(ctx);
        }
      } catch (err) {
        console.error(`[plugins] Error loading module for "${name}":`, err);
      }
    }

    this.plugins.set(manifest.name, { manifest, dir, enabled: true, module: mod });
  }

  /** Run all handlers for a hook. Returns array of results (errors filtered). */
  async runHook(hookName: string, input: any): Promise<any[]> {
    const results: any[] = [];

    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      if (!plugin.manifest.hooks[hookName]) continue;

      const handler = plugin.module?.hooks?.[hookName];
      if (!handler) continue;

      const timeout = plugin.manifest.hooks[hookName].timeout ?? DEFAULT_TIMEOUT;

      try {
        const result = await runWithTimeout(handler, input, timeout);
        if (result !== undefined && result !== null) {
          results.push(result);
        }
      } catch (err) {
        console.error(`[plugins] Hook "${hookName}" in "${plugin.manifest.name}" failed:`, err);
      }
    }

    return results;
  }

  /** List all loaded plugins */
  list(): PluginInfo[] {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      enabled: p.enabled,
      hooks: Object.keys(p.manifest.hooks),
    }));
  }

  /** Enable a plugin */
  enable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = true;
    return true;
  }

  /** Disable a plugin */
  disable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = false;
    return true;
  }

  /** Get plugin config (defaults from manifest) */
  getConfig(name: string): Record<string, unknown> {
    const p = this.plugins.get(name);
    if (!p?.manifest.config) return {};
    const config: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(p.manifest.config)) {
      config[key] = field.default;
    }
    return config;
  }

  /** Shutdown all plugins */
  async shutdown(): Promise<void> {
    for (const [, plugin] of this.plugins) {
      try {
        await plugin.module?.deactivate?.();
      } catch {}
    }
    this.plugins.clear();
  }
}

/** Run a handler with a timeout */
async function runWithTimeout(handler: HookHandler, input: any, timeoutMs: number): Promise<any> {
  return Promise.race([
    Promise.resolve(handler(input)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Hook timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/plugins/host.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/host.ts tests/plugins/host.test.ts
git commit -m "feat: add PluginHost with discovery, hook execution, and timeout protection"
```

---

### Task 3: Wire Plugin Host into Broker

**Files:**
- Modify: `src/broker/index.ts`

- [ ] **Step 1: Initialize PluginHost on broker startup**

In `src/broker/index.ts`, add import at the top:

```typescript
import { PluginHost } from "../plugins/host";
```

Add module-level variable after the `tunnel` variable:

```typescript
let pluginHost: PluginHost | null = null;
```

In `startBroker()`, after `wireStepEngine(db)` (around line 82), add:

```typescript
  // Initialize plugin system
  pluginHost = new PluginHost();
  const pluginDir = join(GROVE_HOME, "plugins");
  await pluginHost.loadAll(pluginDir);
  const loadedPlugins = pluginHost.list();
  if (loadedPlugins.length > 0) {
    console.log(`  Plugins: ${loadedPlugins.map(p => p.name).join(", ")}`);
  }
```

In the `shutdown()` function, add plugin cleanup before other shutdowns:

```typescript
    await pluginHost?.shutdown();
```

Export a getter for other modules to access:

```typescript
/** Get the plugin host instance (for hook execution in other modules) */
export function getPluginHost(): PluginHost | null {
  return pluginHost;
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/broker/index.ts
git commit -m "feat: initialize PluginHost on broker startup"
```

---

### Task 4: Wire Gate Hooks into Evaluator

**Files:**
- Modify: `src/agents/evaluator.ts`

- [ ] **Step 1: Add plugin gate hook call after built-in gates**

In `src/agents/evaluator.ts`, add import at top:

```typescript
import { getPluginHost } from "../broker/index";
```

Find the `evaluate()` function. After `runGates()` returns results and before they're stored in DB, add plugin gate execution:

After the line that runs built-in gates (`const gateResults = runGates(...)`) and before storing in DB, add:

```typescript
  // Run plugin gate hooks
  const host = getPluginHost();
  if (host) {
    try {
      const pluginResults = await host.runHook("gate:custom", {
        taskId: task.id,
        worktreePath,
        treeId: tree.id,
        treePath: tree.path,
      });
      for (const result of pluginResults) {
        if (result && typeof result.passed === "boolean") {
          gateResults.push({
            gate: result.gate ?? "plugin",
            passed: result.passed,
            tier: "hard",
            message: result.message ?? "",
          });
        }
      }
    } catch (err) {
      console.error("[evaluator] Plugin gate hook error:", err);
    }
  }
```

Note: The evaluate function needs to be `async` if it isn't already, since `host.runHook()` returns a Promise. Check the function signature and add `async` if needed.

- [ ] **Step 2: Run evaluator tests**

Run: `bun test tests/agents/evaluator-gates.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/agents/evaluator.ts
git commit -m "feat: wire plugin gate hooks into evaluator"
```

---

### Task 5: Wire Step Hooks into Step Engine

**Files:**
- Modify: `src/engine/step-engine.ts`

- [ ] **Step 1: Add plugin step hooks**

In `src/engine/step-engine.ts`, add import:

```typescript
import { getPluginHost } from "../broker/index";
```

In `executeStep()`, after the event logging (`db.addEvent(task.id, null, "step_entered", ...)`), add step:pre hook:

```typescript
  // Run step:pre plugin hooks
  const host = getPluginHost();
  if (host) {
    try {
      const preResults = await host.runHook("step:pre", {
        taskId: task.id,
        stepId: step.id,
        stepType: step.type,
        treeId: tree.id,
      });
      for (const result of preResults) {
        if (result?.proceed === false) {
          db.addEvent(task.id, null, "step_skipped", `Plugin blocked step "${step.id}": ${result.reason ?? "no reason"}`);
          return;
        }
      }
    } catch (err) {
      console.error("[step-engine] Plugin step:pre hook error:", err);
    }
  }
```

In `onStepComplete()`, after determining the next step target but before executing the transition, add step:post hook:

```typescript
  // Run step:post plugin hooks
  const postHost = getPluginHost();
  if (postHost) {
    try {
      await postHost.runHook("step:post", {
        taskId,
        stepId: task.current_step,
        outcome,
        context,
      });
    } catch (err) {
      console.error("[step-engine] Plugin step:post hook error:", err);
    }
  }
```

- [ ] **Step 2: Run step engine tests**

Run: `bun test tests/engine/step-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/engine/step-engine.ts
git commit -m "feat: wire plugin step:pre/step:post hooks into step engine"
```

---

### Task 6: CLI + API + Integration

**Files:**
- Create: `src/cli/commands/plugins.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/broker/server.ts`

- [ ] **Step 1: Create plugins CLI command**

Create `src/cli/commands/plugins.ts`:

```typescript
// grove plugins — Plugin management
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(args: string[]) {
  const sub = args[0];
  const info = readBrokerInfo();

  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  switch (sub) {
    case "list": {
      try {
        const resp = await fetch(`${info.url}/api/plugins`);
        const plugins = await resp.json() as any[];
        if (plugins.length === 0) {
          console.log(`${pc.dim("No plugins installed.")}`);
          console.log(`${pc.dim("Add plugins to ~/.grove/plugins/")}`);
          return;
        }
        for (const p of plugins) {
          const status = p.enabled ? pc.green("enabled") : pc.dim("disabled");
          console.log(`  ${pc.bold(p.name)} v${p.version} [${status}]`);
          console.log(`    ${pc.dim(p.description)}`);
          console.log(`    hooks: ${p.hooks.join(", ")}`);
        }
      } catch {
        console.log(`${pc.red("Error:")} Could not reach broker`);
      }
      break;
    }

    case "enable": {
      const name = args[1];
      if (!name) { console.log(`${pc.red("Usage:")} grove plugins enable <name>`); return; }
      try {
        const resp = await fetch(`${info.url}/api/plugins/${name}/enable`, { method: "POST" });
        const data = await resp.json() as any;
        if (data.ok) console.log(`${pc.green("✓")} ${name} enabled`);
        else console.log(`${pc.red("Error:")} ${data.error}`);
      } catch { console.log(`${pc.red("Error:")} Could not reach broker`); }
      break;
    }

    case "disable": {
      const name = args[1];
      if (!name) { console.log(`${pc.red("Usage:")} grove plugins disable <name>`); return; }
      try {
        const resp = await fetch(`${info.url}/api/plugins/${name}/disable`, { method: "POST" });
        const data = await resp.json() as any;
        if (data.ok) console.log(`${pc.green("✓")} ${name} disabled`);
        else console.log(`${pc.red("Error:")} ${data.error}`);
      } catch { console.log(`${pc.red("Error:")} Could not reach broker`); }
      break;
    }

    default:
      console.log(`${pc.bold("grove plugins")} — Plugin management

${pc.bold("Usage:")} grove plugins <command>

${pc.bold("Commands:")}
  ${pc.green("list")}                List installed plugins
  ${pc.green("enable")} <name>      Enable a plugin
  ${pc.green("disable")} <name>     Disable a plugin

${pc.bold("Plugin directory:")} ~/.grove/plugins/
`);
  }
}
```

- [ ] **Step 2: Register CLI command**

In `src/cli/index.ts`, add:

```typescript
  plugins: () => import("./commands/plugins"),
```

- [ ] **Step 3: Add API endpoints in server.ts**

In `src/broker/server.ts`, add import:

```typescript
import { getPluginHost } from "./index";
```

In the `handleApi` function, add plugin endpoints before the fallback 404:

```typescript
    // GET /api/plugins — list plugins
    if (path === "/api/plugins" && req.method === "GET") {
      const host = getPluginHost();
      return json(host?.list() ?? []);
    }

    // POST /api/plugins/:name/enable
    const enableMatch = path.match(/^\/api\/plugins\/([^/]+)\/enable$/);
    if (enableMatch && req.method === "POST") {
      const host = getPluginHost();
      const ok = host?.enable(enableMatch[1]) ?? false;
      return json({ ok, error: ok ? undefined : "Plugin not found" });
    }

    // POST /api/plugins/:name/disable
    const disableMatch = path.match(/^\/api\/plugins\/([^/]+)\/disable$/);
    if (disableMatch && req.method === "POST") {
      const host = getPluginHost();
      const ok = host?.disable(disableMatch[1]) ?? false;
      return json({ ok, error: ok ? undefined : "Plugin not found" });
    }
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/plugins.ts src/cli/index.ts src/broker/server.ts
git commit -m "feat: add plugin CLI commands and API endpoints"
```

---

### Task 7: Verify Integration

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Verify plugin host exported and accessible**

Run: `grep -n "getPluginHost" src/broker/index.ts src/agents/evaluator.ts src/engine/step-engine.ts src/broker/server.ts`
Expected: Export in index.ts, imports in evaluator, step-engine, server

- [ ] **Step 3: Verify CLI registered**

Run: `grep "plugins" src/cli/index.ts`
Expected: `plugins: () => import("./commands/plugins")`

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "chore: verify T4 plugin architecture integration"
```
