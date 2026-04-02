// grove insights — Cross-task pattern insights
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

interface InsightsResponse {
  failing_gates: { gate: string; fail_count: number; top_message: string; top_message_count: number }[];
  retries_by_path: { path_name: string; task_count: number; retried_count: number; avg_retries: number; max_retries: number }[];
  tree_failure_rates: { tree_id: string; tree_name: string | null; completed: number; failed: number; total: number; success_rate: number }[];
  success_trend: { date: string; completed: number; failed: number; total: number; success_rate: number }[];
  common_failures: { gate: string; message: string; count: number }[];
}

export async function run(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const validRanges = ["1h", "4h", "24h", "7d"];
  const range = args[0] ?? "7d";
  if (!validRanges.includes(range)) {
    console.log(`${pc.red("Invalid range:")} ${range}. Use one of: ${validRanges.join(", ")}`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/analytics/insights?range=${range}`);
    const data = (await resp.json()) as InsightsResponse;

    console.log(`${pc.bold("Task Outcome Insights")} ${pc.dim(`(${range})`)}`);
    console.log();

    // --- Most-failing gates ---
    if (data.failing_gates.length > 0) {
      console.log(pc.bold("Most-Failing Gates"));
      for (const g of data.failing_gates) {
        const bar = pc.red("█".repeat(Math.min(g.fail_count, 20)));
        console.log(`  ${bar} ${pc.white(g.gate)} ${pc.dim(`${g.fail_count} failures`)}`);
        if (g.top_message) {
          console.log(`     ${pc.dim("→")} ${pc.yellow(g.top_message)} ${pc.dim(`(×${g.top_message_count})`)}`);
        }
      }
      console.log();
    }

    // --- Retries by path ---
    if (data.retries_by_path.length > 0) {
      console.log(pc.bold("Retries by Path"));
      for (const p of data.retries_by_path) {
        const retryPct = p.task_count > 0 ? Math.round((p.retried_count / p.task_count) * 100) : 0;
        console.log(`  ${pc.green(p.path_name.padEnd(20))} ${pc.dim(`${p.task_count} tasks`)}  ${retryPct}% retried  avg ${p.avg_retries.toFixed(1)}  max ${p.max_retries}`);
      }
      console.log();
    }

    // --- Tree failure rates ---
    if (data.tree_failure_rates.length > 0) {
      console.log(pc.bold("Tree Success Rates"));
      for (const t of data.tree_failure_rates) {
        const name = (t.tree_name ?? t.tree_id).padEnd(20);
        const color = t.success_rate >= 80 ? pc.green : t.success_rate >= 50 ? pc.yellow : pc.red;
        console.log(`  ${name} ${color(`${t.success_rate}%`)} ${pc.dim(`(${t.completed}/${t.total})`)}`);
      }
      console.log();
    }

    // --- Success rate trend ---
    if (data.success_trend.length > 0) {
      console.log(pc.bold("Success Rate Trend"));
      for (const d of data.success_trend) {
        const bar = "█".repeat(Math.round(d.success_rate / 5));
        const color = d.success_rate >= 80 ? pc.green : d.success_rate >= 50 ? pc.yellow : pc.red;
        console.log(`  ${pc.dim(d.date)}  ${color(bar)} ${d.success_rate}%  ${pc.dim(`(${d.total} tasks)`)}`);
      }
      console.log();
    }

    // --- Common failures ---
    if (data.common_failures.length > 0) {
      console.log(pc.bold("Common Failure Reasons"));
      for (const f of data.common_failures.slice(0, 5)) {
        console.log(`  ${pc.red(`×${f.count}`)} ${pc.white(f.gate)}: ${pc.dim(f.message)}`);
      }
      console.log();
    }

    if (data.failing_gates.length === 0 && data.common_failures.length === 0) {
      console.log(pc.green("  No failures detected in this time range. 🌳"));
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
