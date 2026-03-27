// grove cost — Spend breakdown
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(_args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/status`);
    const data = await resp.json() as any;

    console.log(`${pc.bold("Cost Summary")}`);
    console.log();
    console.log(`  Today:  ${pc.bold("$" + data.cost.today.toFixed(2))}`);
    console.log(`  Week:   ${pc.bold("$" + data.cost.week.toFixed(2))}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
