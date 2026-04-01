# Plugin Development Guide

Plugins extend Grove without modifying its core. They live in `~/.grove/plugins/` and are loaded automatically when the broker starts.

## Plugin Directory Structure

Each plugin is a directory containing a manifest and an optional JS module:

```
~/.grove/plugins/
└── my-plugin/
    ├── plugin.json   # required — manifest
    └── index.js      # optional — hook implementations
```

Grove scans every subdirectory of `~/.grove/plugins/` for a `plugin.json`. Directories without one are ignored.

## Manifest (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "you",
  "hooks": {
    "gate:custom": {
      "description": "Custom quality gate",
      "timeout": 30000
    }
  },
  "config": {
    "webhook_url": {
      "type": "string",
      "default": "",
      "description": "Slack webhook URL"
    }
  }
}
```

- `hooks` — declares which hooks the plugin implements. Only hooks listed here are invoked.
- `config` — optional. Declares config fields with defaults. Values are passed to `activate()` via `context.config`.
- `timeout` — per-hook, in ms. Default: 60000. Hook is skipped (with error logged) if it exceeds this.

## Available Hooks

| Hook | When invoked | Input type | Return type |
|------|-------------|------------|-------------|
| `step:pre` | Before each pipeline step executes | `StepPreHookInput` | `StepPreHookResult \| void` |
| `step:post` | After each pipeline step completes | `StepPostHookInput` | any |
| `gate:custom` | During gate steps (from evaluator) | `GateHookInput` | `GateHookResult` |
| `notify` | On notification events | `NotifyHookInput` | any |
| `worker:pre_spawn` | Before a worker spawns | `WorkerPreSpawnInput` | `WorkerPreSpawnResult \| void` |

**`step:pre` — block or allow a step:**
```ts
interface StepPreHookInput  { taskId: string; stepId: string; stepType: string; treeId: string; }
interface StepPreHookResult { proceed: boolean; reason?: string; }
```
Return `{ proceed: false, reason: "..." }` to block the step (triggers step failure). Return `void` or `{ proceed: true }` to allow it.

**`step:post` — observe step completion:**
```ts
interface StepPostHookInput { taskId: string; stepId: string; outcome: string; context?: string; }
```
Return value is ignored. Fire-and-forget — errors are swallowed.

**`gate:custom` — add quality checks:**
```ts
interface GateHookInput  { taskId: string; worktreePath: string; treeId: string; treePath: string; }
interface GateHookResult { passed: boolean; message: string; }
```
All registered `gate:custom` handlers run during gate evaluation. Any failure fails the gate.

**`worker:pre_spawn` — modify worker prompt:**
```ts
interface WorkerPreSpawnInput  { taskId: string; treeId: string; prompt: string; }
interface WorkerPreSpawnResult { prompt?: string; }
```
Return `{ prompt: "..." }` to override the prompt passed to the worker.

## Writing a Plugin Module (`index.js`)

```js
module.exports = {
  // Called once when the plugin loads. ctx.config holds manifest defaults.
  async activate(ctx) {
    ctx.log("activated");
  },

  // Called when Grove shuts down.
  async deactivate() {},

  hooks: {
    "gate:custom": async (input) => {
      // input: GateHookInput
      return { passed: true, message: "OK" };
    },

    "step:post": (input) => {
      // fire-and-forget — return value ignored
      console.log(`Step ${input.stepId} finished: ${input.outcome}`);
    },
  },
};
```

Plugins are loaded with CommonJS `require()`. Write `index.js` (not `.ts`) or compile TypeScript beforehand.

## Example: Custom Quality Gate

Blocks tasks whose diff exceeds 500 lines.

**`~/.grove/plugins/diff-guard/plugin.json`:**
```json
{
  "name": "diff-guard",
  "version": "1.0.0",
  "description": "Fails gate if diff is too large",
  "hooks": {
    "gate:custom": { "description": "Check diff size", "timeout": 10000 }
  },
  "config": {
    "max_lines": { "type": "number", "default": 500, "description": "Max diff lines" }
  }
}
```

**`~/.grove/plugins/diff-guard/index.js`:**
```js
const { execFileSync } = require("child_process");

let maxLines = 500;

module.exports = {
  activate(ctx) {
    maxLines = ctx.config.max_lines ?? 500;
  },

  hooks: {
    "gate:custom": (input) => {
      try {
        const out = execFileSync("git", ["diff", "--stat", "HEAD~1"], {
          cwd: input.worktreePath,
          encoding: "utf-8",
        });
        const matches = out.match(/\d+/g) || [];
        const total = matches.reduce((sum, n) => sum + parseInt(n, 10), 0);
        if (total > maxLines) {
          return { passed: false, message: `Diff too large: ${total} lines (max ${maxLines})` };
        }
        return { passed: true, message: `Diff size OK: ${total} lines` };
      } catch {
        return { passed: true, message: "Could not measure diff — skipping check" };
      }
    },
  },
};
```

## Example: Slack Notification Plugin

Posts to Slack when a task completes or fails.

**`~/.grove/plugins/slack-notify/plugin.json`:**
```json
{
  "name": "slack-notify",
  "version": "1.0.0",
  "description": "Post task events to Slack",
  "hooks": {
    "step:post": { "description": "Notify on task completion", "timeout": 5000 }
  },
  "config": {
    "webhook_url": { "type": "string", "default": "", "description": "Slack incoming webhook URL" }
  }
}
```

**`~/.grove/plugins/slack-notify/index.js`:**
```js
let webhookUrl = "";

module.exports = {
  activate(ctx) {
    webhookUrl = ctx.config.webhook_url;
    if (!webhookUrl) ctx.log("warning: webhook_url not set");
  },

  hooks: {
    "step:post": async (input) => {
      if (!webhookUrl) return;
      if (input.stepId !== "merge" && input.outcome !== "failure") return;

      const emoji = input.outcome === "success" ? ":white_check_mark:" : ":x:";
      const text = `${emoji} Task \`${input.taskId}\` — step *${input.stepId}* ${input.outcome}`;

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    },
  },
};
```

**Set the webhook URL** by editing the `default` in `plugin.json`.

## Plugin Configuration

Config defaults come from the `config` block in `plugin.json` and are passed to `activate()` via `ctx.config`. Change defaults directly in `plugin.json` — there is no runtime override mechanism today.

## Testing Plugins Locally

Run the broker and check the startup log — each plugin emits a load message:

```
[plugin:diff-guard] activated
```

Use `grove plugins list` (or `GET /api/plugins`) to verify your plugin loaded:

```
NAME          VERSION  ENABLED  HOOKS
diff-guard    1.0.0    true     gate:custom
slack-notify  1.0.0    true     step:post
```

For isolated unit testing, instantiate `PluginHost` directly against a temp directory:

```js
import { PluginHost } from "./src/plugins/host.js";

const host = new PluginHost();
await host.loadAll("/tmp/test-plugins");
const results = await host.runHook("gate:custom", {
  taskId: "test",
  worktreePath: "/path/to/worktree",
  treeId: "my-tree",
  treePath: "/path/to/tree",
});
console.log(results);
```

Errors in hooks are caught and logged — they never crash the broker. A hook that exceeds its `timeout` is silently dropped.
