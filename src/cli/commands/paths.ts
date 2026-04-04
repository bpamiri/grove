// grove paths — List paths / grove path show|add|remove|export|import
import { readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";
import { DEFAULT_PATHS } from "../../shared/types";
import type { NormalizedPathConfig, PathConfig } from "../../shared/types";

export async function run(args: string[]) {
  const sub = args[0];

  if (sub === "show")   return showPath(args.slice(1));
  if (sub === "add")    return addPath(args.slice(1));
  if (sub === "remove") return removePath(args.slice(1));
  if (sub === "export") return exportPath(args.slice(1));
  if (sub === "import") return importPath(args.slice(1));

  // Default: list
  return listPaths();
}

// ---------------------------------------------------------------------------
// grove paths / grove path list
// ---------------------------------------------------------------------------

async function listPaths() {
  const paths = await fetchPaths();
  if (!paths) return;

  const entries = Object.entries(paths);
  if (entries.length === 0) {
    console.log(`${pc.yellow("No paths configured.")}`);
    return;
  }

  console.log(`${pc.bold("Paths")} (${entries.length})`);
  console.log();

  for (const [name, config] of entries) {
    const builtIn = name in DEFAULT_PATHS ? pc.dim(" (built-in)") : "";
    console.log(`  ${pc.green(name)}${builtIn}`);
    console.log(`    ${pc.dim(config.description)}`);
    console.log(`    ${pc.dim("steps:")} ${config.steps.map(s => s.id).join(" → ")}`);
  }
}

// ---------------------------------------------------------------------------
// grove path show <name>
// ---------------------------------------------------------------------------

async function showPath(args: string[]) {
  const name = args[0];
  if (!name) {
    console.log(`${pc.red("Usage:")} grove path show <name>`);
    return;
  }

  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/paths/${encodeURIComponent(name)}`);
    if (resp.status === 404) {
      console.log(`${pc.red("Path not found:")} ${name}`);
      return;
    }
    const data = await resp.json() as { name: string } & NormalizedPathConfig;

    console.log(`${pc.bold(data.name)}`);
    console.log(`${pc.dim(data.description)}`);
    console.log();

    for (const step of data.steps) {
      const tag = step.type === "verdict"
        ? pc.yellow(`[${step.type}]`)
        : pc.cyan(`[${step.type}]`);
      console.log(`  ${pc.green(step.id)} ${tag}`);

      if (step.label && step.label !== step.id)
        console.log(`    ${pc.dim("label:")} ${step.label}`);
      if (step.prompt)
        console.log(`    ${pc.dim("prompt:")} ${step.prompt.length > 80 ? step.prompt.slice(0, 80) + "…" : step.prompt}`);
      if (step.skills?.length)
        console.log(`    ${pc.dim("skills:")} ${step.skills.join(", ")}`);
      if (step.sandbox !== "read-write")
        console.log(`    ${pc.dim("sandbox:")} ${step.sandbox}`);
      if (step.result_file)
        console.log(`    ${pc.dim("result_file:")} ${step.result_file}`);
      if (step.result_key)
        console.log(`    ${pc.dim("result_key:")} ${step.result_key}`);
      console.log(`    ${pc.dim("on_success:")} ${step.on_success}  ${pc.dim("on_failure:")} ${step.on_failure}`);
      if (step.max_retries)
        console.log(`    ${pc.dim("max_retries:")} ${step.max_retries}`);
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// grove path add <name> [--file <path>] [--description <desc>]
// ---------------------------------------------------------------------------

async function addPath(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  // Parse --file flag
  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx !== -1 ? args[fileIdx + 1] : undefined;

  // Parse --description flag
  const descIdx = args.indexOf("--description");
  const description = descIdx !== -1 ? args[descIdx + 1] : undefined;

  const name = args.find(a => !a.startsWith("--") && a !== filePath && a !== description);
  if (!name) {
    console.log(`${pc.red("Usage:")} grove path add <name> --file <path.json|path.yaml>`);
    console.log(`       grove path add <name> --description "desc" (creates empty single-step path)`);
    return;
  }

  let body: { name: string; description: string; steps: any[] };

  if (filePath) {
    // Import from file
    const content = readFileSync(filePath, "utf-8");
    const parsed = parsePathFile(content, filePath);
    if (!parsed) return;
    body = { name, description: parsed.description, steps: parsed.steps };
  } else if (description) {
    // Create minimal path with a single implement step
    body = {
      name,
      description,
      steps: [
        { id: "implement", type: "worker", prompt: "Implement the task. Commit your changes with conventional commit messages." },
      ],
    };
  } else {
    console.log(`${pc.red("Usage:")} grove path add <name> --file <path.json|path.yaml>`);
    console.log(`       grove path add <name> --description "desc" (creates single-step path)`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.status === 409) {
      console.log(`${pc.red("✘")} Path ${pc.bold(`"${name}"`)} already exists.`);
      return;
    }
    if (resp.status === 400) {
      const data = await resp.json() as any;
      console.log(`${pc.red("✘")} Validation failed:`);
      for (const detail of data.details ?? [data.error]) {
        console.log(`  - ${detail}`);
      }
      return;
    }

    const data = await resp.json() as NormalizedPathConfig;
    console.log(`${pc.green("✓")} Path created: ${pc.bold(name)}`);
    console.log(`  ${pc.dim(data.description)}`);
    console.log(`  ${pc.dim("steps:")} ${data.steps.map(s => s.id).join(" → ")}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// grove path remove <name> [--force]
// ---------------------------------------------------------------------------

async function removePath(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const name = args.find(a => !a.startsWith("--"));
  if (!name) {
    console.log(`${pc.red("Usage:")} grove path remove <name>`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/paths/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });

    if (resp.status === 404) {
      console.log(`${pc.red("Path not found:")} ${name}`);
      return;
    }
    if (resp.status === 403) {
      const data = await resp.json() as any;
      console.log(`${pc.red("✘")} ${data.error}`);
      return;
    }

    console.log(`${pc.green("✓")} Removed path ${pc.bold(`"${name}"`)}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// grove path export <name> [--json | --yaml]
// ---------------------------------------------------------------------------

async function exportPath(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const name = args.find(a => !a.startsWith("--"));
  if (!name) {
    console.log(`${pc.red("Usage:")} grove path export <name> [--json | --yaml] [--output <file>]`);
    return;
  }

  const useJson = args.includes("--json");
  const outputIdx = args.indexOf("--output");
  const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

  try {
    const resp = await fetch(`${info.url}/api/paths/${encodeURIComponent(name)}`);
    if (resp.status === 404) {
      console.log(`${pc.red("Path not found:")} ${name}`);
      return;
    }

    const data = await resp.json() as { name: string } & NormalizedPathConfig;
    const exportData: PathConfig = {
      description: data.description,
      steps: data.steps.map(s => {
        const step: Record<string, any> = { id: s.id, type: s.type };
        if (s.prompt) step.prompt = s.prompt;
        if (s.skills?.length) step.skills = s.skills;
        if (s.sandbox !== "read-write") step.sandbox = s.sandbox;
        if (s.result_file) step.result_file = s.result_file;
        if (s.result_key) step.result_key = s.result_key;
        if (s.on_success !== "$done") step.on_success = s.on_success;
        if (s.on_failure !== "$fail") step.on_failure = s.on_failure;
        if (s.max_retries) step.max_retries = s.max_retries;
        return step;
      }),
    };

    let output: string;
    if (useJson) {
      output = JSON.stringify(exportData, null, 2);
    } else {
      const { stringify } = await import("yaml");
      output = stringify(exportData);
    }

    if (outputFile) {
      writeFileSync(outputFile, output);
      console.log(`${pc.green("✓")} Exported ${pc.bold(name)} to ${outputFile}`);
    } else {
      console.log(output);
    }
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// grove path import <file> [--name <name>]
// ---------------------------------------------------------------------------

async function importPath(args: string[]) {
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const filePath = args.find(a => !a.startsWith("--"));
  if (!filePath) {
    console.log(`${pc.red("Usage:")} grove path import <file> [--name <name>]`);
    return;
  }

  const nameIdx = args.indexOf("--name");
  const nameOverride = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.log(`${pc.red("Cannot read file:")} ${filePath}`);
    return;
  }

  const parsed = parsePathFile(content, filePath);
  if (!parsed) return;

  // Derive name from filename if not provided and not in file
  const name = nameOverride
    ?? parsed.name
    ?? filePath.replace(/^.*[\\/]/, "").replace(/\.(json|ya?ml)$/i, "");

  try {
    const resp = await fetch(`${info.url}/api/paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: parsed.description, steps: parsed.steps }),
    });

    if (resp.status === 409) {
      console.log(`${pc.red("✘")} Path ${pc.bold(`"${name}"`)} already exists.`);
      return;
    }
    if (resp.status === 400) {
      const data = await resp.json() as any;
      console.log(`${pc.red("✘")} Validation failed:`);
      for (const detail of data.details ?? [data.error]) {
        console.log(`  - ${detail}`);
      }
      return;
    }

    const data = await resp.json() as NormalizedPathConfig;
    console.log(`${pc.green("✓")} Imported path: ${pc.bold(name)}`);
    console.log(`  ${pc.dim(data.description)}`);
    console.log(`  ${pc.dim("steps:")} ${data.steps.map(s => s.id).join(" → ")}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPaths(): Promise<Record<string, NormalizedPathConfig> | null> {
  const info = readBrokerInfo();

  if (info) {
    try {
      const resp = await fetch(`${info.url}/api/paths`);
      return await resp.json() as Record<string, NormalizedPathConfig>;
    } catch {
      // Fall through to local config
    }
  }

  // Broker not running — read local config
  const { configNormalizedPathsForApi } = await import("../../broker/config");
  return configNormalizedPathsForApi();
}

function parsePathFile(content: string, filePath: string): { name?: string; description: string; steps: any[] } | null {
  let parsed: any;

  if (filePath.endsWith(".json")) {
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      console.log(`${pc.red("Invalid JSON:")} ${err.message}`);
      return null;
    }
  } else {
    // Assume YAML
    try {
      const { parse } = require("yaml");
      parsed = parse(content);
    } catch (err: any) {
      console.log(`${pc.red("Invalid YAML:")} ${err.message}`);
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    console.log(`${pc.red("Invalid path definition:")} expected an object with description and steps`);
    return null;
  }

  if (!parsed.description || !Array.isArray(parsed.steps)) {
    console.log(`${pc.red("Invalid path definition:")} must have "description" (string) and "steps" (array)`);
    return null;
  }

  return { name: parsed.name, description: parsed.description, steps: parsed.steps };
}
