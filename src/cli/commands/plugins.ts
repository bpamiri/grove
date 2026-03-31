// Grove v3 — Plugin management CLI
import pc from "picocolors";
import { readBrokerInfo } from "../../broker/index";

export async function run(args: string[]) {
  const sub = args[0];
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  switch (sub) {
    case "list": {
      try {
        const resp = await fetch(`${info.url}/api/plugins`);
        const plugins = (await resp.json()) as any[];
        if (plugins.length === 0) {
          console.log(`${pc.dim("No plugins installed. Add plugins to ~/.grove/plugins/")}`);
          return;
        }
        for (const p of plugins) {
          const status = p.enabled ? pc.green("enabled") : pc.dim("disabled");
          console.log(`  ${pc.bold(p.name)} v${p.version} [${status}]`);
          console.log(`    ${pc.dim(p.description)}`);
          console.log(`    hooks: ${p.hooks.join(", ")}`);
        }
      } catch {
        console.log(`${pc.red("Error:")} Could not reach broker`);
      }
      break;
    }

    case "enable": {
      const name = args[1];
      if (!name) {
        console.log(`${pc.red("Usage:")} grove plugins enable <name>`);
        return;
      }
      try {
        const resp = await fetch(`${info.url}/api/plugins/${name}/enable`, { method: "POST" });
        const data = (await resp.json()) as any;
        if (data.ok) console.log(`${pc.green("✓")} ${name} enabled`);
        else console.log(`${pc.red("Error:")} ${data.error}`);
      } catch {
        console.log(`${pc.red("Error:")} Could not reach broker`);
      }
      break;
    }

    case "disable": {
      const name = args[1];
      if (!name) {
        console.log(`${pc.red("Usage:")} grove plugins disable <name>`);
        return;
      }
      try {
        const resp = await fetch(`${info.url}/api/plugins/${name}/disable`, { method: "POST" });
        const data = (await resp.json()) as any;
        if (data.ok) console.log(`${pc.green("✓")} ${name} disabled`);
        else console.log(`${pc.red("Error:")} ${data.error}`);
      } catch {
        console.log(`${pc.red("Error:")} Could not reach broker`);
      }
      break;
    }

    default:
      console.log(
        `${pc.bold("grove plugins")} — Plugin management\n\n` +
          `${pc.bold("Commands:")}\n` +
          `  ${pc.green("list")}                List installed plugins\n` +
          `  ${pc.green("enable")} <name>      Enable a plugin\n` +
          `  ${pc.green("disable")} <name>     Disable a plugin\n\n` +
          `${pc.bold("Plugin directory:")} ~/.grove/plugins/`,
      );
  }
}
