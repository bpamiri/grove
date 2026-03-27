// grove status — Show system status
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";
import { isAlive } from "../../agents/stream-parser";

export async function run(_args: string[]) {
  const info = readBrokerInfo();

  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} to start.`);
    return;
  }

  const brokerAlive = isAlive(info.pid);

  console.log(`${pc.bold(pc.green("Grove Status"))}`);
  console.log();
  console.log(`  Broker:  ${brokerAlive ? pc.green("running") : pc.red("dead")} (PID ${info.pid})`);
  console.log(`  URL:     ${pc.bold(info.url)}`);
  console.log(`  tmux:    ${info.tmuxSession}`);
  console.log(`  Started: ${info.startedAt}`);

  if (brokerAlive) {
    // Fetch status from the running broker
    try {
      const resp = await fetch(`${info.url}/api/status`);
      const data = await resp.json() as any;
      console.log();
      console.log(`  Orchestrator: ${data.orchestrator === "running" ? pc.green("running") : pc.yellow(data.orchestrator)}`);
      console.log(`  Workers:      ${data.workers} active`);
      console.log(`  Tasks:        ${data.tasks.total} total (${data.tasks.running} running, ${data.tasks.done} done)`);
      console.log(`  Cost today:   $${data.cost.today.toFixed(2)}`);
    } catch {
      console.log(`  ${pc.yellow("Could not reach broker API")}`);
    }
  }
}
