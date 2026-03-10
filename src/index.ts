#!/usr/bin/env bun
// Grove v2 — Entry point and command router
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEnv, closeDb } from "./core/db";
import * as ui from "./core/ui";
import { GROVE_VERSION } from "./types";
import type { Command } from "./types";

// ---------------------------------------------------------------------------
// Command imports
// ---------------------------------------------------------------------------
import { initCommand } from "./commands/init";
import { configCommand } from "./commands/config";
import { reposCommand } from "./commands/repos";
import { helpCommand } from "./commands/help";

// Lazy-loaded commands (Units 1-6) — imported on demand to keep startup fast
async function loadCommand(name: string): Promise<Command | null> {
  switch (name) {
    case "hud": return (await import("./commands/hud")).hudCommand;
    case "status": return (await import("./commands/status")).statusCommand;
    case "add": return (await import("./commands/add")).addCommand;
    case "tasks": return (await import("./commands/tasks")).tasksCommand;
    case "plan": return (await import("./commands/plan")).planCommand;
    case "prioritize": return (await import("./commands/prioritize")).prioritizeCommand;
    case "sync": return (await import("./commands/sync")).syncCommand;
    case "work": return (await import("./commands/work")).workCommand;
    case "run": return (await import("./commands/work")).workCommand;
    case "resume": return (await import("./commands/resume")).resumeCommand;
    case "pause": return (await import("./commands/pause")).pauseCommand;
    case "cancel": return (await import("./commands/cancel")).cancelCommand;
    case "watch": return (await import("./commands/watch")).watchCommand;
    case "detach": return (await import("./commands/detach")).detachCommand;
    case "msg": return (await import("./commands/msg")).msgCommand;
    case "dashboard": return (await import("./commands/dashboard")).dashboardCommand;
    case "prs": return (await import("./commands/prs")).prsCommand;
    case "review": return (await import("./commands/review")).reviewCommand;
    case "done": return (await import("./commands/done")).doneCommand;
    case "close": return (await import("./commands/close")).closeCommand;
    case "report": return (await import("./commands/report")).reportCommand;
    case "cost": return (await import("./commands/cost")).costCommand;
    case "log": return (await import("./commands/log")).logCommand;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap commands (always loaded)
// ---------------------------------------------------------------------------
const commands = new Map<string, Command>();
commands.set("init", initCommand);
commands.set("config", configCommand);
commands.set("repos", reposCommand);
commands.set("help", helpCommand);

// All known command names (for help listing and validation)
const allCommandNames = [
  "init", "config", "repos", "help",
  "hud", "status",
  "add", "tasks", "plan", "prioritize", "sync",
  "work", "run", "resume", "pause", "cancel",
  "watch", "detach", "msg", "dashboard",
  "prs", "review", "done", "close",
  "report", "cost", "log",
];

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
async function main() {
  // Set GROVE_ROOT if not already set
  if (!process.env.GROVE_ROOT) {
    process.env.GROVE_ROOT = join(import.meta.dir, "..");
  }

  const args = process.argv.slice(2);
  const commandName = args[0];

  // No arguments → HUD (or welcome message)
  if (!commandName) {
    const { GROVE_DB } = getEnv();
    if (!existsSync(GROVE_DB)) {
      ui.info(`Welcome to Grove v${GROVE_VERSION}`);
      console.log(`\n  Run ${ui.bold("grove init")} to get started.\n`);
      return;
    }
    // Try to load HUD
    const hudCmd = await loadCommand("hud");
    if (hudCmd) {
      await hudCmd.run([]);
    } else {
      ui.info(`Grove v${GROVE_VERSION}`);
      console.log("\n  HUD not yet available. Try:");
      console.log("    grove status    — quick summary");
      console.log("    grove help      — list all commands");
      console.log("    grove repos     — list configured repos\n");
    }
    return;
  }

  const restArgs = args.slice(1);

  // Check bootstrap commands first
  if (commands.has(commandName)) {
    const cmd = commands.get(commandName)!;
    if (commandName === "help") {
      // Pass commands map to help for detailed per-command help
      const allCmds = new Map(commands);
      for (const name of allCommandNames) {
        if (!allCmds.has(name)) {
          const loaded = await loadCommand(name);
          if (loaded) allCmds.set(name, loaded);
        }
      }
      await (cmd.run as any)(restArgs, allCmds);
    } else {
      await cmd.run(restArgs);
    }
    return;
  }

  // Try lazy-loaded commands
  const cmd = await loadCommand(commandName);
  if (cmd) {
    await cmd.run(restArgs);
    return;
  }

  ui.error(`Unknown command: ${commandName}`);
  console.error('Run "grove help" for available commands.');
  process.exit(1);
}

// Run
main()
  .catch((err) => {
    ui.error(err.message || String(err));
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
