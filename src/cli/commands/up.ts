// grove up — Start broker + orchestrator + tunnel
import pc from "picocolors";
import { startBroker, readBrokerInfo } from "../../broker/index";
import { getOrCreateToken } from "../../broker/auth";
import { checkForUpdate } from "../update-check";
import { GROVE_VERSION } from "../../shared/types";

export async function run(_args: string[]) {
  // Check if already running
  const existing = readBrokerInfo();
  if (existing) {
    console.log(`${pc.yellow("Grove is already running.")}`);
    console.log(`  Local:  ${pc.bold(existing.url)}`);
    return;
  }

  console.log(`${pc.green("Starting Grove")} ${pc.dim(`v${GROVE_VERSION}`)}`)

  try {
    const info = await startBroker();
    const token = getOrCreateToken();

    console.log();
    console.log(`  ${pc.green("✓")} Broker started (PID ${info.pid})`);
    console.log(`  ${pc.green("✓")} Orchestrator ready (starts on first message)`);
    if (info.tunnelUrl) {
      console.log(`  ${pc.green("✓")} Tunnel active`);
    }
    if (info.remoteUrl && info.remoteUrl !== info.tunnelUrl) {
      console.log(`  ${pc.green("✓")} Registered on grove.cloud`);
    }
    console.log();
    console.log(`  Local:   ${pc.bold(info.url)}`);
    if (info.tunnelUrl) {
      console.log(`  Tunnel:  ${pc.dim(info.tunnelUrl)}`);
    }
    if (info.remoteUrl) {
      console.log(`  Remote:  ${pc.bold(`${info.remoteUrl}?token=${token}`)}`);
    }
    console.log();
    console.log(`${pc.dim("Press Ctrl+C to stop.")}`);

    // Fire-and-forget update check
    checkForUpdate();

    // Keep the process alive
    await new Promise(() => {});
  } catch (err: any) {
    console.error(`${pc.red("Failed to start:")} ${err.message}`);
    process.exit(1);
  }
}
