// grove sync — Pull issues from GitHub repos and create/update tasks
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import { SourceType, EventType } from "../types";
import type { Command, Task, Repo } from "../types";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  state: string;
  url: string;
}

export const syncCommand: Command = {
  name: "sync",
  description: "Pull issues from GitHub repos",

  async run(args: string[]) {
    const db = getDb();
    const repoConfigs = configRepoDetail();

    let filterRepo = "";
    let dryRun = false;

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if ((arg === "--repo" || arg === "-r") && i + 1 < args.length) {
        filterRepo = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--repo=")) {
        filterRepo = arg.slice("--repo=".length);
        i++;
      } else if (arg === "--dry-run") {
        dryRun = true;
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    const repos = Object.entries(repoConfigs);
    if (repos.length === 0) {
      ui.die("No repos configured. Run 'grove init' first.");
    }

    const targetRepos = filterRepo
      ? repos.filter(([name]) => name === filterRepo)
      : repos;

    if (filterRepo && targetRepos.length === 0) {
      ui.die(`Repo '${filterRepo}' not found in config.`);
    }

    ui.header("Sync GitHub Issues");

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    for (const [repoName, rc] of targetRepos) {
      const ghRepo = rc.github || `${rc.org}/${repoName}`;
      ui.info(`Syncing ${ghRepo}...`);

      // Upsert repo metadata
      if (!dryRun) {
        const repo: Repo = {
          name: repoName,
          org: rc.org,
          github_full: ghRepo,
          local_path: rc.path,
          branch_prefix: rc.branch_prefix || "grove/",
          claude_md_path: null,
          last_synced: null,
        };
        db.repoUpsert(repo);
      }

      // Fetch open issues via gh CLI (array form — safe, no shell injection)
      const ghArgs = [
        "gh", "issue", "list",
        "--repo", ghRepo,
        "--state", "open",
        "--json", "number,title,body,labels,state,url",
        "--limit", "100",
      ];
      const result = Bun.spawnSync(ghArgs);

      if (result.exitCode !== 0) {
        ui.warn(`Failed to fetch issues for ${ghRepo}: ${result.stderr.toString().trim()}`);
        continue;
      }

      let issues: GhIssue[];
      try {
        issues = JSON.parse(result.stdout.toString());
      } catch {
        ui.warn(`Invalid JSON from gh for ${ghRepo}`);
        continue;
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const issue of issues) {
        const sourceRef = `${repoName}#${issue.number}`;

        // Check for existing task by source_ref
        const existing = db.get<Task>(
          "SELECT * FROM tasks WHERE source_ref = ?",
          [sourceRef],
        );

        if (existing) {
          // Update if title or description changed
          const titleChanged = existing.title !== issue.title;
          const bodyChanged = existing.description !== (issue.body || "");

          if (titleChanged || bodyChanged) {
            if (dryRun) {
              console.log(`  ${ui.pc.yellow("update")} ${sourceRef}: ${ui.truncate(issue.title, 50)}`);
            } else {
              db.taskSet(existing.id, "title", issue.title);
              db.taskSet(existing.id, "description", issue.body || "");
            }
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // Create new task
        const prefix = repoName.charAt(0).toUpperCase();
        const taskId = db.nextTaskId(prefix);

        if (dryRun) {
          console.log(`  ${ui.pc.green("create")} ${taskId} ${sourceRef}: ${ui.truncate(issue.title, 50)}`);
        } else {
          db.exec(
            `INSERT INTO tasks (id, repo, source_type, source_ref, title, description, status, priority)
             VALUES (?, ?, ?, ?, ?, ?, 'ingested', 50)`,
            [taskId, repoName, SourceType.GithubIssue, sourceRef, issue.title, issue.body || ""],
          );
          db.addEvent(taskId, EventType.Synced, `Synced from ${sourceRef}`);
        }
        created++;
      }

      // Update last_synced
      if (!dryRun) {
        db.exec(
          "UPDATE repos SET last_synced = datetime('now') WHERE name = ?",
          [repoName],
        );
      }

      // Log sync event
      if (!dryRun && (created > 0 || updated > 0)) {
        db.addEvent(
          null,
          EventType.Synced,
          `Synced ${ghRepo}: ${created} created, ${updated} updated, ${skipped} unchanged`,
        );
      }

      console.log(
        `  ${repoName}: ${ui.pc.green(`${created} created`)}, ${ui.pc.yellow(`${updated} updated`)}, ${ui.dim(`${skipped} unchanged`)}`,
      );

      totalCreated += created;
      totalUpdated += updated;
      totalSkipped += skipped;
    }

    // Summary
    console.log();
    if (dryRun) {
      ui.info(`Dry run complete. Would create ${totalCreated}, update ${totalUpdated}, skip ${totalSkipped}.`);
    } else {
      ui.success(`Sync complete: ${totalCreated} created, ${totalUpdated} updated, ${totalSkipped} unchanged.`);
    }
  },

  help() {
    return [
      "Usage: grove sync [--repo NAME] [--dry-run]",
      "",
      "Pull open issues from GitHub repos and create/update tasks.",
      "",
      "Options:",
      "  --repo, -r NAME    Sync a specific repo only",
      "  --dry-run          Show what would happen without making changes",
      "",
      "Behavior:",
      "  - Fetches open issues via 'gh issue list --json'",
      "  - Deduplicates by source_ref (repo#issue_num)",
      "  - Creates new tasks for unseen issues",
      "  - Updates title/description if changed",
      "  - Upserts repo metadata in the DB",
      "  - Logs sync events",
    ].join("\n");
  },
};
