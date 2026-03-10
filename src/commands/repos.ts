// grove repos — List configured repositories
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEnv, getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import type { Command } from "../types";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}

export const reposCommand: Command = {
  name: "repos",
  description: "List configured repositories",

  async run() {
    const { GROVE_CONFIG } = getEnv();

    if (!existsSync(GROVE_CONFIG)) {
      ui.die(`Grove config not found at ${GROVE_CONFIG}. Run 'grove init' first.`);
    }

    const repos = configRepoDetail();
    const repoNames = Object.keys(repos);

    if (repoNames.length === 0) {
      ui.warn("No repos configured. Edit grove.yaml to add repos.");
      return;
    }

    ui.header("Configured Repositories");

    let db;
    try { db = getDb(); } catch { db = null; }

    for (const name of repoNames) {
      const repo = repos[name];
      const fullPath = expandHome(repo.path);
      const pathExists = existsSync(fullPath);

      const pathBadge = pathExists
        ? ui.badge("✓", "green")
        : ui.badge("✗", "red");

      // Get task count and last sync from DB if available
      let taskCount = 0;
      let lastSynced = "";
      if (db) {
        try {
          taskCount = db.scalar<number>(
            "SELECT COUNT(*) FROM tasks WHERE repo = ?", [name]
          ) ?? 0;
          const repoRow = db.repoGet(name);
          if (repoRow?.last_synced) {
            lastSynced = ui.relativeTime(repoRow.last_synced);
          }
        } catch { /* DB may not be initialized */ }
      }

      console.log(`  ${ui.bold(name)}`);
      console.log(`    Org:    ${repo.org}`);
      console.log(`    GitHub: ${repo.github}`);
      console.log(`    Path:   ${repo.path} ${pathBadge}`);
      if (taskCount > 0) {
        console.log(`    Tasks:  ${taskCount}`);
      }
      if (lastSynced) {
        console.log(`    Synced: ${lastSynced}`);
      }
      console.log();
    }
  },

  help() {
    return `Usage: grove repos

Lists all repositories configured in grove.yaml with:
  - Organization and GitHub URL
  - Local path (with existence check)
  - Task count (if database exists)
  - Last sync time`;
  },
};
