#!/usr/bin/env bun
// Grove v2 — Entry point and command router
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEnv, closeDb } from "./core/db";
import { syncReposToDb } from "./core/config";
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
    case "edit": return (await import("./commands/edit")).editCommand;
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
    case "health": return (await import("./commands/health")).healthCommand;
    case "prs": return (await import("./commands/prs")).prsCommand;
    case "review": return (await import("./commands/review")).reviewCommand;
    case "done": return (await import("./commands/done")).doneCommand;
    case "publish": return (await import("./commands/publish")).publishCommand;
    case "close": return (await import("./commands/close")).closeCommand;
    case "delete": return (await import("./commands/delete")).deleteCommand;
    case "report": return (await import("./commands/report")).reportCommand;
    case "cost": return (await import("./commands/cost")).costCommand;
    case "log": return (await import("./commands/log")).logCommand;
    case "drain": return (await import("./commands/drain")).drainCommand;
    case "gc": return (await import("./commands/gc")).gcCommand;
    case "scan": return (await import("./commands/scan")).scanCommand;
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
  "add", "tasks", "edit", "plan", "prioritize", "sync", "scan",
  "work", "run", "drain", "resume", "pause", "cancel",
  "watch", "detach", "msg", "dashboard", "health",
  "prs", "review", "done", "publish", "close", "delete",
  "report", "cost", "log", "gc",
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

  // Sync repos from config → DB (ensures FK targets exist)
  const { GROVE_DB } = getEnv();
  if (existsSync(GROVE_DB) && commandName !== "init") {
    syncReposToDb();
  }

  // No arguments → HUD (or welcome message)
  if (!commandName) {
    if (!existsSync(GROVE_DB)) {
      ui.logo();
      console.log(`  Run ${ui.bold("grove init")} to get started.\n`);
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
