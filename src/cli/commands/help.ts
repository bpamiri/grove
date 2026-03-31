// grove help — Show help
import pc from "picocolors";
import { GROVE_VERSION } from "../../shared/types";

export async function run(_args: string[]) {
  console.log(`
${pc.bold(pc.green("grove"))} ${pc.dim(`v${GROVE_VERSION}`)} — AI development orchestrator

${pc.bold("Usage:")} grove <command> [options]

${pc.bold("Setup:")}
  ${pc.green("init")}              Initialize Grove (~/.grove)
  ${pc.green("up")}                Start broker + orchestrator + tunnel
  ${pc.green("down")}              Stop everything gracefully

${pc.bold("Trees:")}
  ${pc.green("trees")}             List configured trees (repos)
  ${pc.green("tree add")} <path>   Add a new tree
  ${pc.green("tree rescan")} <name>  Re-detect GitHub remote for a tree
  ${pc.green("tree remove")} <name>  Remove a tree from Grove

${pc.bold("Monitoring:")}
  ${pc.green("status")}            Show system status (broker, workers, tunnel)
  ${pc.green("tasks")}             List tasks with filtering
  ${pc.green("cost")}              Spend breakdown

${pc.bold("Interaction:")}
  ${pc.green("chat")} "message"    Send a message to the orchestrator
  ${pc.green("task add")} "title"  Create a new task

${pc.bold("Configuration:")}
  Edit ${pc.bold("~/.grove/grove.yaml")} to configure trees, paths, budgets, and settings.

${pc.bold("More info:")} https://grove.cloud
`);
}
