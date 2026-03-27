// grove up — Start broker + orchestrator + tunnel
import pc from "picocolors";
import { startBroker, readBrokerInfo } from "../../broker/index";
import { getOrCreateToken } from "../../broker/auth";

export async function run(_args: string[]) {
  // Check if already running
  const existing = readBrokerInfo();
  if (existing) {
    console.log(`${pc.yellow("Grove is already running.")}`);
    console.log(`  Local:  ${pc.bold(existing.url)}`);
    console.log(`  tmux:   ${pc.dim("tmux attach -t grove")}`);
    return;
  }

  console.log(`${pc.green("Starting Grove...")}`)

  try {
    const info = await startBroker();
    const token = getOrCreateToken();

    console.log();
    console.log(`  ${pc.green("✓")} Broker started (PID ${info.pid})`);
    console.log(`  ${pc.green("✓")} Orchestrator spawned in tmux:grove`);
    if (info.remoteUrl) {
      console.log(`  ${pc.green("✓")} Tunnel active`);
    }
    console.log();
    console.log(`  Local:   ${pc.bold(info.url)}`);
    if (info.remoteUrl) {
      console.log(`  Remote:  ${pc.bold(info.remoteUrl)}`);
    }
    console.log(`  Token:   ${pc.dim(token)}`);
    console.log(`  tmux:    ${pc.dim("tmux attach -t grove")}`);
    console.log();
    console.log(`${pc.dim("Press Ctrl+C to stop.")}`);

    // Keep the process alive
    await new Promise(() => {});
  } catch (err: any) {
    console.error(`${pc.red("Failed to start:")} ${err.message}`);
    process.exit(1);
  }
}
