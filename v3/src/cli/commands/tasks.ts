// grove tasks — List tasks / grove task add
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  // grove task add "title"
  if (args[0] === "add") {
    const title = args.slice(1).join(" ").replace(/^["']|["']$/g, "");
    if (!title) {
      console.log(`${pc.red("Usage:")} grove task add "task title"`);
      return;
    }

    try {
      const resp = await fetch(`${info.url}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const task = await resp.json() as any;
      console.log(`${pc.green("✓")} Task created: ${pc.bold(task.id)} — ${task.title}`);
    } catch (err: any) {
      console.log(`${pc.red("Error:")} ${err.message}`);
    }
    return;
  }

  // grove tasks [--status <status>] [--tree <tree>]
  try {
    const url = new URL(`${info.url}/api/tasks`);
    const statusFilter = args.find((a, i) => args[i - 1] === "--status");
    const treeFilter = args.find((a, i) => args[i - 1] === "--tree");
    if (statusFilter) url.searchParams.set("status", statusFilter);
    if (treeFilter) url.searchParams.set("tree", treeFilter);

    const resp = await fetch(url.toString());
    const tasks = await resp.json() as any[];

    if (tasks.length === 0) {
      console.log(`${pc.yellow("No tasks.")}`);
      return;
    }

    console.log(`${pc.bold("Tasks")} (${tasks.length})`);
    console.log();

    for (const task of tasks) {
      const statusColors: Record<string, (s: string) => string> = {
        planned: pc.dim,
        ready: pc.cyan,
        running: pc.blue,
        paused: pc.yellow,
        done: pc.green,
        evaluating: pc.magenta,
        merged: pc.green,
        completed: pc.green,
        failed: pc.red,
      };
      const statusColor = statusColors[task.status as string] ?? pc.white;

      console.log(`  ${pc.bold(task.id)} ${statusColor(`[${task.status}]`)} ${task.title}`);
      const details = [
        task.tree_id && `tree: ${task.tree_id}`,
        task.path_name && `path: ${task.path_name}`,
        task.cost_usd > 0 && `$${task.cost_usd.toFixed(2)}`,
      ].filter(Boolean).join(" · ");
      if (details) console.log(`    ${pc.dim(details)}`);
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
