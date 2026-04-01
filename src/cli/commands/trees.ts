// grove trees — List configured trees / grove tree add <path>
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import { loadConfig, configTrees, configSet, reloadConfig } from "../../broker/config";
import { expandHome } from "../../shared/worktree";
import { detectGithubRemote } from "../../shared/github";

export async function run(args: string[]) {
  // grove tree add <path> [--github org/repo] [--name name]
  if (args[0] === "add" || (args[0] === "tree" && args[1] === "add")) {
    const addArgs = args[0] === "add" ? args.slice(1) : args.slice(2);
    await addTree(addArgs);
    return;
  }

  // grove tree rescan <name>
  if (args[0] === "rescan" || (args[0] === "tree" && args[1] === "rescan")) {
    const rescanArgs = args[0] === "rescan" ? args.slice(1) : args.slice(2);
    await rescanTree(rescanArgs);
    return;
  }

  // grove tree remove <name> [--force]
  if (args[0] === "remove" || (args[0] === "tree" && args[1] === "remove")) {
    const removeArgs = args[0] === "remove" ? args.slice(1) : args.slice(2);
    await removeTree(removeArgs);
    return;
  }

  // grove trees — list
  const trees = configTrees();
  const entries = Object.entries(trees);

  if (entries.length === 0) {
    console.log(`${pc.yellow("No trees configured.")}`);
    console.log(`Add one with: ${pc.bold("grove tree add ~/path/to/repo")}`);
    return;
  }

  console.log(`${pc.bold("Trees")} (${entries.length})`);
  console.log();

  for (const [id, tree] of entries) {
    const github = tree.github ? pc.dim(` (${tree.github})`) : "";
    const path = expandHome(tree.path);
    const exists = existsSync(path);
    const pathStatus = exists ? pc.green(path) : pc.red(`${path} (not found)`);

    console.log(`  ${pc.green(id)}${github}`);
    console.log(`    ${pc.dim("path:")} ${pathStatus}`);
    if (tree.branch_prefix) console.log(`    ${pc.dim("prefix:")} ${tree.branch_prefix}`);
  }
}

async function addTree(args: string[]) {
  // Parse arguments
  let treePath = args.find(a => !a.startsWith("--"));
  const githubIdx = args.indexOf("--github");
  const github = githubIdx !== -1 ? args[githubIdx + 1] : undefined;
  const nameIdx = args.indexOf("--name");
  const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  if (!treePath) {
    console.log(`${pc.red("Usage:")} grove tree add <path> [--github org/repo] [--name name]`);
    return;
  }

  // Resolve and validate path
  treePath = treePath.startsWith("~") ? expandHome(treePath) : resolve(treePath);

  if (!existsSync(treePath)) {
    console.log(`${pc.red("Path not found:")} ${treePath}`);
    return;
  }

  if (!existsSync(`${treePath}/.git`)) {
    console.log(`${pc.red("Not a git repository:")} ${treePath}`);
    return;
  }

  // Derive tree ID from name or directory
  const treeId = (name || basename(treePath)).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Auto-detect GitHub remote if not provided
  let detectedGithub = github;
  if (!detectedGithub) {
    detectedGithub = detectGithubRemote(treePath) ?? undefined;
  }

  // Check if tree already exists
  const existing = configTrees();
  if (existing[treeId]) {
    console.log(`${pc.yellow("Tree")} ${pc.bold(treeId)} ${pc.yellow("already exists. Updating...")}`);
  }

  // Use ~ path if under home directory for portability
  const home = homedir();
  const storedPath = treePath.startsWith(home) ? `~${treePath.slice(home.length)}` : treePath;

  // Write to config
  configSet(`trees.${treeId}.path`, storedPath);
  if (detectedGithub) {
    configSet(`trees.${treeId}.github`, detectedGithub);
  }

  reloadConfig();

  console.log(`${pc.green("✓")} Tree added: ${pc.bold(treeId)}`);
  console.log(`  path:   ${storedPath}`);
  if (detectedGithub) console.log(`  github: ${detectedGithub}`);
  console.log();
  console.log(`${pc.dim("View all trees:")} grove trees`);
}

async function rescanTree(args: string[]) {
  const { readBrokerInfo } = await import("../../broker/index");
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const treeId = args.find(a => !a.startsWith("--"));
  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove tree rescan <name>`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/trees/${encodeURIComponent(treeId)}/rescan`, {
      method: "POST",
    });

    if (resp.status === 404) {
      console.log(`${pc.red("Tree not found:")} ${treeId}`);
      return;
    }

    const data = await resp.json() as any;
    const oldGithub = data.old_github ?? "null";
    const newGithub = data.github ?? "null";
    console.log(`${pc.green("✓")} Rescanned ${pc.bold(treeId)}`);
    console.log(`  github: ${newGithub}${oldGithub !== newGithub ? pc.dim(` (was: ${oldGithub})`) : ""}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

async function removeTree(args: string[]) {
  const { readBrokerInfo } = await import("../../broker/index");
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const force = args.includes("--force");
  const treeId = args.find(a => !a.startsWith("--"));
  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove tree remove <name> [--force]`);
    return;
  }

  try {
    const url = `${info.url}/api/trees/${encodeURIComponent(treeId)}${force ? "?force=true" : ""}`;
    const resp = await fetch(url, { method: "DELETE" });

    if (resp.status === 404) {
      console.log(`${pc.red("Tree not found:")} ${treeId}`);
      return;
    }

    if (resp.status === 409) {
      const data = await resp.json() as any;
      console.log(`${pc.red("✘")} Tree ${pc.bold(`"${treeId}"`)} has ${data.task_count} tasks. Use ${pc.bold("--force")} to remove the tree and all its tasks.`);
      return;
    }

    const data = await resp.json() as any;
    const suffix = data.tasks_deleted > 0 ? ` (${data.tasks_deleted} tasks deleted)` : "";
    console.log(`${pc.green("✓")} Removed tree ${pc.bold(`"${treeId}"`)}${suffix}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
