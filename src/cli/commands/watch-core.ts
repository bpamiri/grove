// grove watch — Pure functions and event wiring (no broker imports)
// Split from watch.ts to enable unit testing without triggering build artifacts.
import pc from "picocolors";
import { readFileSync, existsSync } from "node:fs";
import { bus } from "../../broker/event-bus";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchTaskSpec {
  title: string;
  tree: string;
  path?: string;
  description?: string;
}

export interface WatchOptions {
  tasks: WatchTaskSpec[];
  timeout?: number;       // ms
  budget?: number;        // USD
  noMerge: boolean;
  json: boolean;
  verbose: boolean;
}

export interface TaskState {
  id: string;
  title: string;
  status: string;
  startedAt: number;
  cost: number;
  tokens: number;
  prUrl?: string;
  prNumber?: number;
  failReason?: string;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(args: string[]): WatchOptions | null {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  let tree: string | null = null;
  let title: string | null = null;
  let path: string | null = null;
  let description: string | null = null;
  let tasksFile: string | null = null;
  let timeout: number | undefined;
  let budget: number | undefined;
  let noMerge = false;
  let json = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--tree":
        tree = args[++i];
        break;
      case "--title":
        title = args[++i];
        break;
      case "--path":
        path = args[++i];
        break;
      case "--description":
        description = args[++i];
        break;
      case "--tasks":
        tasksFile = args[++i];
        break;
      case "--timeout":
        timeout = parseDuration(args[++i]);
        if (!timeout) {
          console.log(`${pc.red("Invalid --timeout value.")} Use: 5m, 30m, 1h, 90s`);
          return null;
        }
        break;
      case "--budget":
        budget = parseFloat(args[++i]);
        if (isNaN(budget) || budget <= 0) {
          console.log(`${pc.red("Invalid --budget value.")} Specify USD amount, e.g. 5.00`);
          return null;
        }
        break;
      case "--no-merge":
        noMerge = true;
        break;
      case "--json":
        json = true;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
    }
  }

  // Build task list
  const tasks: WatchTaskSpec[] = [];

  if (tasksFile) {
    if (!existsSync(tasksFile)) {
      console.log(`${pc.red("File not found:")} ${tasksFile}`);
      return null;
    }
    try {
      const raw = JSON.parse(readFileSync(tasksFile, "utf-8"));
      const items = Array.isArray(raw) ? raw : raw.tasks;
      if (!Array.isArray(items) || items.length === 0) {
        console.log(`${pc.red("No tasks found in")} ${tasksFile}`);
        return null;
      }
      for (const item of items) {
        if (!item.title || !item.tree) {
          console.log(`${pc.red("Each task must have 'title' and 'tree' fields.")}`);
          return null;
        }
        tasks.push({
          title: item.title,
          tree: item.tree,
          path: item.path,
          description: item.description,
        });
      }
    } catch (err: any) {
      console.log(`${pc.red("Failed to parse tasks file:")} ${err.message}`);
      return null;
    }
  } else {
    if (!tree || !title) {
      console.log(`${pc.red("Usage:")} grove watch --tree <tree> --title "task title" [options]`);
      console.log(`       grove watch --tasks tasks.json [options]`);
      console.log(`\nRun ${pc.bold("grove watch --help")} for details.`);
      return null;
    }
    tasks.push({ title, tree, path: path ?? undefined, description: description ?? undefined });
  }

  return { tasks, timeout, budget, noMerge, json, verbose };
}

export function parseDuration(s: string): number | undefined {
  if (!s) return undefined;
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Event streaming
// ---------------------------------------------------------------------------

export function wireEventListeners(
  watched: Map<string, TaskState>,
  unsubs: Array<() => void>,
  opts: WatchOptions,
): void {
  // Task status transitions
  unsubs.push(
    bus.on("task:status", ({ taskId, status }) => {
      const state = watched.get(taskId);
      if (!state) return;
      const prev = state.status;
      state.status = status;
      log("status", `${pc.bold(taskId)} ${pc.dim(prev)} → ${statusColor(status)(status)}`);
    }),
  );

  // Worker activity (concise one-liners)
  unsubs.push(
    bus.on("worker:activity", ({ taskId, msg }) => {
      if (!watched.has(taskId)) return;
      log("activity", `${pc.dim(taskId)} ${msg}`);
    }),
  );

  // Agent tool use (verbose mode only)
  if (opts.verbose) {
    unsubs.push(
      bus.on("agent:tool_use", ({ taskId, tool, input }) => {
        if (!watched.has(taskId)) return;
        const truncated = input.length > 80 ? input.slice(0, 80) + "..." : input;
        log("tool", `${pc.dim(taskId)} ${pc.cyan(tool)} ${pc.dim(truncated)}`);
      }),
    );
  }

  // Worker lifecycle
  unsubs.push(
    bus.on("worker:spawned", ({ taskId, pid }) => {
      if (!watched.has(taskId)) return;
      log("info", `${pc.dim(taskId)} worker spawned (PID ${pid})`);
    }),
  );

  unsubs.push(
    bus.on("worker:ended", ({ taskId, status }) => {
      if (!watched.has(taskId)) return;
      const icon = status === "success" ? pc.green("✓") : pc.red("✗");
      log("info", `${pc.dim(taskId)} worker ended ${icon}`);
    }),
  );

  // Gate results
  unsubs.push(
    bus.on("gate:result", ({ taskId, gate, passed, message }) => {
      if (!watched.has(taskId)) return;
      const icon = passed ? pc.green("✓") : pc.red("✗");
      log("gate", `${pc.dim(taskId)} ${gate} ${icon} ${pc.dim(message)}`);
    }),
  );

  // Merge lifecycle
  unsubs.push(
    bus.on("merge:pr_created", ({ taskId, prUrl, prNumber }) => {
      const state = watched.get(taskId);
      if (!state) return;
      state.prUrl = prUrl;
      state.prNumber = prNumber;
      log("merge", `${pc.dim(taskId)} PR #${prNumber} created — ${pc.dim(prUrl)}`);
    }),
  );

  unsubs.push(
    bus.on("merge:completed", ({ taskId, prNumber }) => {
      if (!watched.has(taskId)) return;
      log("merge", `${pc.dim(taskId)} PR #${prNumber} merged ${pc.green("✓")}`);
    }),
  );

  // Cost tracking
  unsubs.push(
    bus.on("cost:updated", ({ taskId, usd, tokens }) => {
      const state = watched.get(taskId);
      if (!state) return;
      state.cost = usd;
      state.tokens = tokens;
    }),
  );

  // Budget enforcement
  if (opts.budget) {
    unsubs.push(
      bus.on("cost:updated", ({ taskId, usd }) => {
        const state = watched.get(taskId);
        if (!state) return;
        if (usd >= opts.budget!) {
          log("error", `Budget exceeded for ${taskId}: $${usd.toFixed(2)} >= $${opts.budget!.toFixed(2)}`);
          state.status = "failed";
          state.failReason = "budget_exceeded";
        }
      }),
    );
  }

  // --no-merge: intercept when merge step begins
  if (opts.noMerge) {
    unsubs.push(
      bus.on("task:updated", ({ taskId, field, value }) => {
        if (!watched.has(taskId)) return;
        if (field === "current_step" && value === "merge") {
          log("info", `${pc.dim(taskId)} --no-merge: stopping before merge step`);
          const state = watched.get(taskId);
          if (state) {
            state.status = "completed";
            state.failReason = "no_merge_stop";
          }
        }
      }),
    );
  }
}

export function waitForCompletion(watched: Map<string, TaskState>): Promise<number> {
  return new Promise((resolve) => {
    const check = () => {
      const allDone = [...watched.values()].every(
        (s) => s.status === "completed" || s.status === "failed",
      );
      if (allDone) {
        const anyFailed = [...watched.values()].some((s) => s.status === "failed");
        resolve(anyFailed ? 1 : 0);
      }
    };

    // Check periodically — events update state, this polls for terminal
    const interval = setInterval(() => {
      check();
      const allDone = [...watched.values()].every(
        (s) => s.status === "completed" || s.status === "failed",
      );
      if (allDone) clearInterval(interval);
    }, 500);

    // Also check immediately on status events
    bus.on("task:status", () => {
      check();
      const allDone = [...watched.values()].every(
        (s) => s.status === "completed" || s.status === "failed",
      );
      if (allDone) clearInterval(interval);
    });
  });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function log(level: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const prefix = {
    ok:       pc.green("✓"),
    error:    pc.red("✗"),
    info:     pc.blue("ℹ"),
    status:   pc.magenta("⟫"),
    activity: pc.dim("·"),
    tool:     pc.cyan("⚙"),
    gate:     pc.yellow("◆"),
    merge:    pc.green("⎇"),
  }[level] ?? pc.dim("·");

  console.log(`${pc.dim(ts)} ${prefix} ${msg}`);
}

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "completed": return pc.green;
    case "failed":    return pc.red;
    case "active":    return pc.blue;
    case "queued":    return pc.cyan;
    default:          return pc.dim;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function printSummary(watched: Map<string, TaskState>, opts: WatchOptions): void {
  console.log();

  if (opts.json) {
    const results = [...watched.values()].map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      duration_ms: Date.now() - s.startedAt,
      cost_usd: s.cost,
      tokens: s.tokens,
      pr_url: s.prUrl ?? null,
    }));
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const total = watched.size;
  const completed = [...watched.values()].filter((s) => s.status === "completed").length;
  const failed = [...watched.values()].filter((s) => s.status === "failed").length;
  const totalCost = [...watched.values()].reduce((sum, s) => sum + s.cost, 0);

  console.log(pc.bold("─── Summary ───────────────────────────────"));
  for (const state of watched.values()) {
    const dur = formatDuration(Date.now() - state.startedAt);
    const icon = state.status === "completed" ? pc.green("✓") : pc.red("✗");
    const cost = state.cost > 0 ? pc.dim(` $${state.cost.toFixed(2)}`) : "";
    const pr = state.prUrl ? pc.dim(` ${state.prUrl}`) : "";
    console.log(`  ${icon} ${pc.bold(state.id)} ${state.title} ${pc.dim(`(${dur})`)}${cost}${pr}`);
  }
  console.log();
  console.log(
    `  ${pc.bold(String(total))} task(s): ${pc.green(String(completed))} completed, ${pc.red(String(failed))} failed` +
    (totalCost > 0 ? ` · $${totalCost.toFixed(2)}` : ""),
  );
  console.log(pc.dim("───────────────────────────────────────────"));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printHelp(): void {
  console.log(`${pc.bold("grove watch")} — Headless mode for CI and scripted use

${pc.bold("Usage:")}
  grove watch --tree <tree> --title "Fix bug" [options]
  grove watch --tasks tasks.json [options]

${pc.bold("Task options:")}
  --tree <id>          Target tree (repo)
  --title <text>       Task title
  --path <name>        Pipeline path (default: tree's default or "development")
  --description <text> Task description

${pc.bold("Batch:")}
  --tasks <file>       JSON file with array of task specs
                       Each: { "title": "...", "tree": "...", "path?": "...", "description?": "..." }

${pc.bold("Execution:")}
  --timeout <dur>      Max duration before exit 1 (e.g. 30m, 1h, 90s)
  --budget <usd>       Max spend per task before exit 1 (e.g. 5.00)
  --no-merge           Stop before the merge step

${pc.bold("Output:")}
  --json               Print results as JSON on completion
  --verbose, -v        Show detailed agent tool use

${pc.bold("Examples:")}
  grove watch --tree myrepo --title "Fix #42"
  grove watch --tree myrepo --title "Add tests" --path adversarial --timeout 30m
  grove watch --tasks batch.json --budget 10.00 --no-merge
  grove watch --tree myrepo --title "Refactor auth" --json`);
}
