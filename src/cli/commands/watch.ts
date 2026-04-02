// grove watch — Headless mode for CI and scripted use
// Starts broker, creates task(s), streams progress to stdout, exits on completion.
import { startBroker, readBrokerInfo, type BrokerInfo } from "../../broker/index";
import {
  parseArgs,
  wireEventListeners,
  waitForCompletion,
  printSummary,
  formatDuration,
  log,
  type TaskState,
  type WatchTaskSpec,
} from "./watch-core";

export async function run(args: string[]) {
  const opts = parseArgs(args);
  if (!opts) return;

  // Start embedded broker (or connect to existing)
  let info: BrokerInfo;
  const existing = readBrokerInfo();
  if (existing) {
    log("info", `Connecting to running broker at ${existing.url}`);
    info = existing;
  } else {
    log("info", "Starting broker...");
    try {
      info = await startBroker();
      log("ok", `Broker started on port ${info.port}`);
    } catch (err: any) {
      log("error", `Failed to start broker: ${err.message}`);
      process.exit(1);
    }
  }

  const baseUrl = info.url;

  // Resolve tree IDs (validate they exist)
  const treesResp = await fetch(`${baseUrl}/api/trees`);
  const trees = (await treesResp.json()) as Array<{ id: string }>;
  const treeIds = new Set(trees.map((t) => t.id));

  for (const spec of opts.tasks) {
    if (!treeIds.has(spec.tree)) {
      log("error", `Tree "${spec.tree}" not found. Available: ${[...treeIds].join(", ")}`);
      process.exit(1);
    }
  }

  // Track task states
  const watched = new Map<string, TaskState>();
  const unsubs: Array<() => void> = [];

  // Wire event listeners before creating tasks
  wireEventListeners(watched, unsubs, opts);

  // Create and dispatch tasks
  for (const spec of opts.tasks) {
    const taskId = await createAndDispatch(baseUrl, spec);
    if (!taskId) {
      log("error", `Failed to create task: ${spec.title}`);
      cleanup(unsubs);
      process.exit(1);
    }
    watched.set(taskId, {
      id: taskId,
      title: spec.title,
      status: "queued",
      startedAt: Date.now(),
      cost: 0,
      tokens: 0,
    });
    log("ok", `${taskId} created and dispatched — ${spec.title}`);
  }

  // Set up timeout if specified
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeout) {
    timeoutHandle = setTimeout(() => {
      log("error", `Timeout reached (${formatDuration(opts.timeout!)})`);
      cleanup(unsubs);
      printSummary(watched, opts);
      process.exit(1);
    }, opts.timeout);
  }

  // Wait for all tasks to reach terminal state
  const exitCode = await waitForCompletion(watched);

  if (timeoutHandle) clearTimeout(timeoutHandle);
  cleanup(unsubs);
  printSummary(watched, opts);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Task creation + dispatch
// ---------------------------------------------------------------------------

async function createAndDispatch(
  baseUrl: string,
  spec: WatchTaskSpec,
): Promise<string | null> {
  try {
    // Create task
    const createResp = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: spec.title,
        tree_id: spec.tree,
        path_name: spec.path,
        description: spec.description,
      }),
    });
    if (!createResp.ok) return null;
    const task = (await createResp.json()) as any;
    const taskId = task.id as string;

    // Dispatch
    const dispatchResp = await fetch(`${baseUrl}/api/tasks/${taskId}/dispatch`, {
      method: "POST",
    });
    if (!dispatchResp.ok) return null;

    return taskId;
  } catch {
    return null;
  }
}

function cleanup(unsubs: Array<() => void>): void {
  for (const unsub of unsubs) unsub();
}
