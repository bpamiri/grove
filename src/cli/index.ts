#!/usr/bin/env bun
// Grove v3 — CLI entry point and command router
import pc from "picocolors";
import { GROVE_VERSION } from "../shared/types";

const commands: Record<string, () => Promise<{ run(args: string[]): Promise<void> }>> = {
  _guard: () => import("./commands/_guard"),
  init:   () => import("./commands/init"),
  up:     () => import("./commands/up"),
  down:   () => import("./commands/down"),
  status: () => import("./commands/status"),
  trees:  () => import("./commands/trees"),
  tree:   () => import("./commands/trees"),   // alias: grove tree add
  tasks:  () => import("./commands/tasks"),
  task:   () => import("./commands/tasks"),   // alias: grove task add
  watch:  () => import("./commands/watch"),
  batch:  () => import("./commands/batch"),
  chat:   () => import("./commands/chat"),
  config:  () => import("./commands/config"),
  cost:     () => import("./commands/cost"),
  insights: () => import("./commands/insights"),
  cleanup:  () => import("./commands/cleanup"),
  plugins: () => import("./commands/plugins"),
  skills: () => import("./commands/skills"),
  help:    () => import("./commands/help"),
  upgrade: () => import("./commands/upgrade"),
};

async function main() {
  const args = process.argv.slice(2);
  const cmdName = args[0];

  if (!cmdName || cmdName === "--help" || cmdName === "-h") {
    printUsage();
    return;
  }

  if (cmdName === "--version" || cmdName === "-v") {
    console.log(`grove ${GROVE_VERSION}`);
    return;
  }

  const loader = commands[cmdName];
  if (!loader) {
    console.log(`${pc.red("Unknown command:")} ${cmdName}`);
    console.log(`Run ${pc.bold("grove help")} for available commands.`);
    process.exit(1);
  }

  const cmd = await loader();
  await cmd.run(args.slice(1));
}

function printUsage() {
  console.log(`
${pc.bold(pc.green("grove"))} ${pc.dim(`v${GROVE_VERSION}`)} — AI development orchestrator

${pc.bold("Usage:")} grove <command> [options]

${pc.bold("Commands:")}
  ${pc.green("init")}      Initialize Grove (~/.grove)
  ${pc.green("up")}        Start broker + orchestrator + tunnel
  ${pc.green("down")}      Stop everything gracefully
  ${pc.green("status")}    Show system status
  ${pc.green("trees")}     List configured trees (repos)
  ${pc.green("tasks")}     List tasks
  ${pc.green("watch")}     Run headless — create, dispatch, stream, exit
  ${pc.green("batch")}     Analyze tasks, plan execution waves
  ${pc.green("chat")}      Send a message to the orchestrator
  ${pc.green("config")}    Manage config (version, validate, migrate)
  ${pc.green("cost")}      Spend breakdown
  ${pc.green("insights")}  Cross-task pattern insights
  ${pc.green("plugins")}   Manage plugins
  ${pc.green("skills")}    Manage the skill library
  ${pc.green("help")}      Show this help
  ${pc.green("upgrade")}   Upgrade to latest version
`);
}

main().catch((err) => {
  console.error(pc.red("Error:"), err.message);
  process.exit(1);
});
