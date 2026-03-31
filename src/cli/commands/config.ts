import pc from "picocolors";
import { loadConfig } from "../../broker/config";
import {
  detectVersion,
  latestVersion,
  migrateConfig,
  validateConfig,
} from "../../broker/config-migrations";

export async function run(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case "version": {
      const config = loadConfig();
      const current = detectVersion(config);
      const latest = latestVersion();
      console.log(`Current: v${current}`);
      console.log(`Latest:  v${latest}`);
      if (current < latest)
        console.log(
          `${pc.yellow("\u26A0")} Config is outdated. Run ${pc.bold("grove config migrate")} to upgrade.`,
        );
      else console.log(`${pc.green("\u2713")} Config is up to date.`);
      break;
    }
    case "validate": {
      const config = loadConfig();
      const errors = validateConfig(config);
      if (errors.length === 0)
        console.log(`${pc.green("\u2713")} Config is valid.`);
      else {
        console.log(`${pc.red("Issues found:")}`);
        for (const err of errors)
          console.log(`  ${pc.yellow("\u2022")} ${err}`);
      }
      break;
    }
    case "migrate": {
      const { readFileSync, writeFileSync, copyFileSync } = await import(
        "node:fs"
      );
      const { getEnv } = await import("../../broker/db");
      const yaml = await import("yaml");
      const { GROVE_CONFIG } = getEnv();
      const raw = yaml.parse(readFileSync(GROVE_CONFIG, "utf-8"));
      const current = detectVersion(raw);
      const latest = latestVersion();
      if (current >= latest) {
        console.log(`${pc.green("\u2713")} Config is already at v${latest}.`);
        break;
      }
      const backupPath = GROVE_CONFIG + ".bak";
      copyFileSync(GROVE_CONFIG, backupPath);
      console.log(`${pc.dim("Backup:")} ${backupPath}`);
      const { config: migrated, applied } = migrateConfig(raw);
      writeFileSync(GROVE_CONFIG, yaml.stringify(migrated));
      console.log(
        `${pc.green("\u2713")} Migrated v${current} \u2192 v${latest}`,
      );
      for (const desc of applied)
        console.log(`  ${pc.dim("\u2022")} ${desc}`);
      break;
    }
    default:
      console.log(
        `${pc.bold("grove config")} \u2014 Configuration management\n\n${pc.bold("Commands:")}\n  ${pc.green("version")}     Show config version\n  ${pc.green("validate")}    Check for errors\n  ${pc.green("migrate")}     Upgrade config (creates .bak backup)`,
      );
  }
}
