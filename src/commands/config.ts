// grove config — View/edit Grove configuration
import { existsSync } from "node:fs";
import { getEnv } from "../core/db";
import { configGet, configSet, loadConfig, validateConfig } from "../core/config";
import * as ui from "../core/ui";
import type { Command } from "../types";

export const configCommand: Command = {
  name: "config",
  description: "View or edit Grove configuration",

  async run(args: string[]) {
    const { GROVE_CONFIG } = getEnv();

    if (!existsSync(GROVE_CONFIG)) {
      ui.die(`Grove config not found at ${GROVE_CONFIG}. Run 'grove init' first.`);
    }

    const subcommand = args[0];

    if (!subcommand) {
      // Show full config
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    if (subcommand === "get") {
      const key = args[1];
      if (!key) {
        ui.die("Usage: grove config get KEY (e.g., budgets.per_week)");
      }
      const value = configGet(key);
      if (value === undefined) {
        ui.die(`Key not found: ${key}`);
      }
      if (typeof value === "object") {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value));
      }
      return;
    }

    if (subcommand === "set") {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        ui.die("Usage: grove config set KEY VALUE");
      }
      configSet(key, value);
      ui.success(`Set ${key} = ${value}`);
      return;
    }

    if (subcommand === "edit") {
      const editor = process.env.EDITOR || "vi";
      const proc = Bun.spawn([editor, GROVE_CONFIG], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      return;
    }

    if (subcommand === "validate") {
      const errors = validateConfig();
      if (errors.length > 0) {
        for (const e of errors) ui.error(e);
        process.exit(1);
      }
      ui.success("Config is valid.");
      return;
    }

    ui.die(`Unknown subcommand: ${subcommand}. Use get, set, edit, or validate.`);
  },

  help() {
    return `Usage: grove config [SUBCOMMAND]

Subcommands:
  (none)           Show full config as JSON
  get KEY          Get a value by dot-notation (e.g., budgets.per_week)
  set KEY VALUE    Set a value by dot-notation
  edit             Open config in $EDITOR
  validate         Check config for required fields

Examples:
  grove config
  grove config get budgets.per_week
  grove config set budgets.per_week 200
  grove config edit`;
  },
};
