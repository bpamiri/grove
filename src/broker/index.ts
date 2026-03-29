// Grove v3 — Broker main process
// Starts HTTP server, tmux session, orchestrator, and manages lifecycle.
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { Database, getEnv } from "./db";
import { startServer, stopServer, setRemoteUrl } from "./server";
import * as tmux from "./tmux";
import * as orchestrator from "../agents/orchestrator";
import { loadConfig, configTrees, tunnelConfig, configSet } from "./config";
import { bus } from "./event-bus";
import { wireStepEngine } from "../engine/step-engine";
import { initDispatch } from "./dispatch";
import { startHealthMonitor, stopHealthMonitor, recoverOrphanedTasks } from "../monitor/health";
import { startCostMonitor, stopCostMonitor } from "../monitor/cost";
import { CloudflareTunnel } from "../tunnel/cloudflare";
import type { TunnelProvider } from "../tunnel/provider";
import { generateSubdomain, generateSecret } from "./subdomain";
import { registerGrove, startHeartbeat, stopHeartbeat, deregisterGrove } from "./registry";

export interface BrokerInfo {
  pid: number;
  port: number;
  url: string;
  tunnelUrl: string | null;  // raw quick-tunnel URL (trycloudflare.com)
  remoteUrl: string | null;  // vanity URL (grove.cloud) or tunnel URL if no domain
  tmuxSession: string;
  startedAt: string;
}

let tunnel: TunnelProvider | null = null;

/** Start the broker — the central process that manages everything */
export async function startBroker(): Promise<BrokerInfo> {
  const { GROVE_HOME, GROVE_DB, GROVE_LOG_DIR } = getEnv();

  // Ensure directories exist
  mkdirSync(GROVE_HOME, { recursive: true });
  mkdirSync(GROVE_LOG_DIR, { recursive: true });

  // Initialize database (use embedded schema for compiled binary compatibility)
  const { SCHEMA_SQL } = await import("./schema-sql");
  const db = new Database(GROVE_DB);
  db.initFromString(SCHEMA_SQL);

  // Clear stale messages from previous sessions
  db.clearMessages();

  // Load config and sync trees to DB
  const config = loadConfig();
  const trees = configTrees();
  for (const [id, treeConfig] of Object.entries(trees)) {
    db.treeUpsert({
      id,
      name: id,
      path: treeConfig.path,
      github: treeConfig.github,
      branch_prefix: treeConfig.branch_prefix ?? config.settings.branch_prefix,
      config: JSON.stringify({ quality_gates: treeConfig.quality_gates, default_branch: treeConfig.default_branch }),
    });
  }

  // Check tmux
  if (!tmux.isTmuxAvailable()) {
    throw new Error("tmux is not installed. Install it with: brew install tmux");
  }

  // Create tmux session
  tmux.createSession();

  // Find available port
  const port = config.server.port === "auto" ? await findAvailablePort() : config.server.port;

  // Start HTTP server (serve web/dist if it exists)
  const webDistDir = join(import.meta.dir, "../../web/dist");
  const server = startServer({
    db,
    port,
    staticDir: existsSync(webDistDir) ? webDistDir : undefined,
    onChat: (text) => {
      orchestrator.sendMessage(text);
    },
  });

  const url = `http://localhost:${port}`;

  // Wire step engine
  wireStepEngine(db);

  // Initialize dispatch system (concurrent worker queue)
  initDispatch({ db, maxWorkers: config.settings.max_workers });

  // Recover tasks orphaned by previous crash/restart
  recoverOrphanedTasks(db);

  // Start monitors
  startHealthMonitor({
    db,
    stallTimeoutMinutes: config.settings.stall_timeout_minutes,
    onOrchestratorCrash: () => {
      console.log("Orchestrator crashed — restarting...");
      orchestrator.spawn(db, GROVE_LOG_DIR);
    },
  });
  startCostMonitor({ db, budgets: config.budgets });

  // Wire notifications
  const { wireNotifications } = await import("../notifications");
  const { notificationsConfig: getNotificationsConfig } = await import("./config");
  wireNotifications(getNotificationsConfig());

  // Spawn orchestrator
  orchestrator.spawn(db, GROVE_LOG_DIR);

  // Start tunnel (if configured)
  let tunnelUrl: string | null = null;
  let remoteUrl: string | null = null;
  const tConfig = tunnelConfig();
  if (tConfig.provider === "cloudflare") {
    try {
      tunnel = new CloudflareTunnel();
      tunnelUrl = await tunnel.start(port);

      // Register with grove.cloud Worker if domain is configured
      if (tConfig.domain) {
        // Generate subdomain + secret on first run
        if (!tConfig.subdomain) {
          tConfig.subdomain = generateSubdomain();
          configSet("tunnel.subdomain", tConfig.subdomain);
        }
        if (!tConfig.secret) {
          tConfig.secret = generateSecret();
          configSet("tunnel.secret", tConfig.secret);
        }

        try {
          const registryUrl = `https://${tConfig.domain}`;
          remoteUrl = await registerGrove({
            registryUrl,
            subdomain: tConfig.subdomain,
            target: tunnelUrl,
            secret: tConfig.secret,
          });
          setRemoteUrl(remoteUrl);
          startHeartbeat({
            registryUrl,
            subdomain: tConfig.subdomain,
            target: tunnelUrl,
            secret: tConfig.secret,
          });
        } catch (err: any) {
          console.log(`  Registry: ${err.message}`);
          // Fall back to raw tunnel URL
          remoteUrl = tunnelUrl;
          setRemoteUrl(remoteUrl);
        }
      } else {
        remoteUrl = tunnelUrl;
        setRemoteUrl(remoteUrl);
      }
    } catch (err: any) {
      console.log(`  Tunnel: ${err.message}`);
      // Non-fatal — continue without tunnel
    }
  }

  // Write broker info file
  const info: BrokerInfo = {
    pid: process.pid,
    port,
    url,
    tunnelUrl,
    remoteUrl,
    tmuxSession: "grove",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(GROVE_HOME, "broker.json"), JSON.stringify(info, null, 2));

  db.addEvent(null, null, "broker_started", `Broker started on port ${port}${remoteUrl ? ` (tunnel: ${remoteUrl})` : ""}`);

  // Handle shutdown signals
  const shutdown = () => {
    console.log("\nShutting down...");
    stopHealthMonitor();
    stopCostMonitor();
    stopHeartbeat();
    // Deregister from grove.cloud (best-effort, non-blocking)
    const tc = tunnelConfig();
    if (tc.domain && tc.subdomain && tc.secret) {
      deregisterGrove({
        registryUrl: `https://${tc.domain}`,
        subdomain: tc.subdomain,
        secret: tc.secret,
      }).catch(() => {});
    }
    tunnel?.stop();
    orchestrator.stop(db);
    tmux.killSession();
    stopServer();
    db.addEvent(null, null, "broker_stopped", "Broker stopped");
    db.close();
    // Remove broker.json
    try { Bun.spawnSync(["rm", "-f", join(GROVE_HOME, "broker.json")]); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return info;
}

/** Find an available TCP port */
async function findAvailablePort(startPort: number = 49152): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") });
      server.stop();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("No available port found");
}

/** Read broker info from disk (for CLI commands to find the running broker) */
export function readBrokerInfo(): BrokerInfo | null {
  const { GROVE_HOME } = getEnv();
  const infoPath = join(GROVE_HOME, "broker.json");
  if (!existsSync(infoPath)) return null;
  try {
    const { readFileSync } = require("node:fs");
    return JSON.parse(readFileSync(infoPath, "utf-8")) as BrokerInfo;
  } catch {
    return null;
  }
}
