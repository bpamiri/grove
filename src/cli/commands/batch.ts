// grove batch — Analyze draft tasks, build dependency graph, dispatch in optimal order
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  // Parse args: grove batch <tree> [--run] [--json] [--agent] [--hybrid]
  let treeId: string | null = null;
  let autoRun = false;
  let jsonOutput = false;
  let mode: "heuristic" | "agent" | "hybrid" = "heuristic";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run") {
      autoRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--agent") {
      mode = "agent";
    } else if (arg === "--hybrid") {
      mode = "hybrid";
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    } else if (!arg.startsWith("-")) {
      treeId = arg;
    }
  }

  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove batch <tree> [--run] [--json] [--agent] [--hybrid]`);
    console.log(`\nRun ${pc.bold("grove batch --help")} for details.`);
    return;
  }

  // Call broker API to analyze
  try {
    const modeLabel = mode === "agent" ? " (AI analysis)" : mode === "hybrid" ? " (hybrid analysis)" : "";
    console.log(`${pc.dim("Analyzing draft tasks for")} ${pc.bold(treeId)}${pc.dim(modeLabel + "...")}`);
    console.log();

    const resp = await fetch(`${info.url}/api/batch/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ treeId, mode }),
    });

    if (!resp.ok) {
      const err = await resp.json() as any;
      console.log(`${pc.red("Error:")} ${err.error}`);
      return;
    }

    const plan = await resp.json() as any;

    if (jsonOutput) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    // Display results
    if (plan.tasks.length === 0) {
      console.log(`${pc.yellow("No draft tasks found for")} ${pc.bold(treeId)}`);
      return;
    }

    // Task analysis summary
    console.log(pc.bold(`${plan.tasks.length} draft task(s) analyzed:`));
    console.log();
    for (const t of plan.tasks) {
      const conf = t.confidence === "high" ? pc.green("high") :
                   t.confidence === "medium" ? pc.yellow("medium") : pc.red("low");
      const fileCount = t.predictedFiles.length;
      console.log(`  ${pc.bold(t.taskId)}  ${t.title}`);
      console.log(`    ${pc.dim("Predicted files:")} ${fileCount > 0 ? t.predictedFiles.join(", ") : pc.dim("none")} ${pc.dim(`(${conf} confidence)`)}`);
    }
    console.log();

    // Overlap matrix
    if (plan.overlaps.length > 0) {
      console.log(pc.bold("Predicted file overlap:"));
      for (const o of plan.overlaps) {
        console.log(`  ${pc.bold(o.taskA)} ${pc.dim("×")} ${pc.bold(o.taskB)}: ${o.sharedFiles.join(", ")} ${pc.dim(`(${o.sharedFiles.length} file${o.sharedFiles.length > 1 ? "s" : ""})`)}`);
      }
      console.log();
    } else {
      console.log(`${pc.green("No file overlap detected")} — all tasks can run in parallel.`);
      console.log();
    }

    // Execution waves
    console.log(pc.bold("Execution waves:"));
    for (const wave of plan.waves) {
      const parallel = wave.taskIds.length > 1 ? "parallel" : "single";
      const label = wave.wave === 1 ? pc.green(`Wave ${wave.wave}`) : pc.yellow(`Wave ${wave.wave}`);
      console.log(`  ${label} (${parallel}): ${wave.taskIds.map((id: string) => pc.bold(id)).join(", ")}`);
    }
    console.log();

    // Dispatch prompt
    if (autoRun) {
      await dispatchWave(info.url, treeId, 1);
    } else if (plan.waves.length > 0) {
      const wave1 = plan.waves[0];
      console.log(`${pc.dim("To dispatch wave 1:")} ${pc.bold(`grove batch ${treeId} --run`)}`);
    }

  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

async function dispatchWave(brokerUrl: string, treeId: string, wave: number) {
  try {
    console.log(`${pc.dim("Dispatching wave")} ${pc.bold(String(wave))}${pc.dim("...")}`);

    const resp = await fetch(`${brokerUrl}/api/batch/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ treeId, wave }),
    });

    if (!resp.ok) {
      const err = await resp.json() as any;
      console.log(`${pc.red("Error:")} ${err.error}`);
      return;
    }

    const result = await resp.json() as any;
    console.log(`${pc.green("✓")} Dispatched ${result.dispatched.length} task(s): ${result.dispatched.map((id: string) => pc.bold(id)).join(", ")}`);

    if (Object.keys(result.dependsOnSet).length > 0) {
      console.log(`${pc.dim("Dependencies set for later waves:")}`);
      for (const [taskId, deps] of Object.entries(result.dependsOnSet)) {
        console.log(`  ${pc.bold(taskId)} ${pc.dim("depends on")} ${deps}`);
      }
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

function printHelp() {
  console.log(`Usage: grove batch <tree> [--run] [--json] [--agent] [--hybrid]

Analyze draft tasks for a tree, predict file overlap, and plan execution waves.

What it does:
  1. Gathers all draft tasks for the specified tree
  2. Predicts which files each task will modify
  3. Builds an overlap matrix of shared file predictions
  4. Derives execution waves (conflict-free parallel groups)
  5. Shows the plan and optionally dispatches wave 1

Analysis modes:
  (default)   Heuristic — regex-based file prediction (free, instant)
  --agent     AI-assisted — Claude analyzes all tasks (accurate, ~$0.01-0.05)
  --hybrid    Heuristic first, AI fallback for low-confidence tasks

Options:
  --run     Analyze and auto-dispatch wave 1
  --json    Output the batch plan as JSON
  --help    Show this help

Examples:
  grove batch grove              Analyze with heuristic (default)
  grove batch grove --agent      Analyze with AI
  grove batch grove --hybrid     Heuristic + AI fallback
  grove batch grove --agent --run  AI analysis + dispatch wave 1`);
}
