// grove down — Stop everything gracefully
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";
import { isAlive } from "../../agents/stream-parser";

export async function run(_args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")}`);
    return;
  }

  if (!isAlive(info.pid)) {
    console.log(`${pc.yellow("Broker process is dead. Cleaning up...")}`);
    cleanup();
    return;
  }

  // Send SIGTERM to the broker process
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`${pc.green("✓")} Sent shutdown signal to broker (PID ${info.pid})`);
    console.log(`${pc.dim("Broker will clean up tmux session and stop.")}`);
  } catch (err: any) {
    console.log(`${pc.yellow("Could not signal broker:")} ${err.message}`);
    cleanup();
  }
}

function cleanup() {
  // Force kill tmux session if it exists
  Bun.spawnSync(["tmux", "kill-session", "-t", "grove"]);
  // Remove broker.json
  const { join } = require("node:path");
  const { getEnv } = require("../../broker/db");
  const { GROVE_HOME } = getEnv();
  Bun.spawnSync(["rm", "-f", join(GROVE_HOME, "broker.json")]);
  console.log(`${pc.green("✓")} Cleaned up.`);
}
