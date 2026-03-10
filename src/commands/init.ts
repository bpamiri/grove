// grove init — Initialize Grove setup
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { getEnv, initDb } from "../core/db";
import { confirm } from "../core/prompts";
import * as ui from "../core/ui";
import { GROVE_VERSION } from "../types";
import type { Command } from "../types";

export const initCommand: Command = {
  name: "init",
  description: "Initialize Grove (~/.grove directory, config, database)",

  async run() {
    const { GROVE_HOME, GROVE_ROOT, GROVE_CONFIG, GROVE_LOG_DIR } = getEnv();

    // Create GROVE_HOME
    if (!existsSync(GROVE_HOME)) {
      mkdirSync(GROVE_HOME, { recursive: true });
      ui.success(`Created ${GROVE_HOME}`);
    } else {
      ui.info(`${GROVE_HOME} already exists.`);
    }

    // Create logs directory
    if (!existsSync(GROVE_LOG_DIR)) {
      mkdirSync(GROVE_LOG_DIR, { recursive: true });
    }

    // Copy example config if no config exists
    const exampleConfig = join(GROVE_ROOT, "grove.yaml.example");
    if (!existsSync(GROVE_CONFIG)) {
      if (existsSync(exampleConfig)) {
        copyFileSync(exampleConfig, GROVE_CONFIG);
        ui.success(`Created ${GROVE_CONFIG} from example`);
      } else {
        ui.warn("No grove.yaml.example found — create grove.yaml manually.");
      }
    } else {
      const overwrite = await confirm("grove.yaml already exists. Overwrite?");
      if (overwrite && existsSync(exampleConfig)) {
        copyFileSync(exampleConfig, GROVE_CONFIG);
        ui.success("Config overwritten.");
      }
    }

    // Initialize database
    const db = initDb();
    db.configSet("initialized_at", new Date().toISOString());
    db.configSet("grove_version", GROVE_VERSION);
    db.addEvent(null, "created", `Grove v${GROVE_VERSION} initialized`);
    ui.success("Database initialized.");

    console.log(`\n  Edit ${ui.bold(GROVE_CONFIG)} to add your repos.`);
    console.log(`  Then run ${ui.bold("grove repos")} to verify.\n`);
  },

  help() {
    return `Usage: grove init

Creates the ~/.grove directory with:
  grove.yaml  — configuration file (copied from example)
  grove.db    — SQLite database for task/session tracking
  logs/       — worker output logs

Safe to run multiple times — won't overwrite existing config
without confirmation.`;
  },
};
