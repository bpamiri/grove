// grove cleanup — Prune stale worktrees
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(_args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/cleanup/worktrees`, {
      method: "POST",
    });
    const data = await resp.json() as { pruned: Array<{ taskId: string; treeId: string; reason: string }>; errors: string[] };

    if (data.pruned.length === 0) {
      console.log(`${pc.green("✓")} No stale worktrees found`);
      return;
    }

    console.log(`${pc.green("✓")} Pruned ${data.pruned.length} stale worktree${data.pruned.length === 1 ? "" : "s"}`);
    for (const entry of data.pruned) {
      console.log(`  ${entry.taskId} ${pc.dim(`(${entry.reason})`)} — ${entry.treeId}`);
    }

    if (data.errors.length > 0) {
      console.log();
      console.log(`${pc.yellow("Errors:")}`);
      for (const err of data.errors) {
        console.log(`  ${pc.red("✘")} ${err}`);
      }
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
