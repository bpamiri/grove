// grove prs — List all open Grove PRs across repos
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import type { Command, Task } from "../types";

interface GhPr {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  url: string;
  repository: { nameWithOwner: string };
}

function prStatusBadge(pr: GhPr): string {
  if (pr.isDraft) return ui.badge("draft", "dim");
  if (pr.reviewDecision === "APPROVED") return ui.badge("approved", "green");
  if (pr.reviewDecision === "CHANGES_REQUESTED") return ui.badge("changes", "yellow");
  return ui.badge("open", "blue");
}

export const prsCommand: Command = {
  name: "prs",
  description: "List open Grove PRs across repos",

  async run(args: string[]) {
    const db = getDb();
    const repoConfigs = configRepoDetail();

    let filterRepo = "";

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
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    // Determine repos to scan
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

    ui.header("Open Grove PRs");

    const allPrs: { repoName: string; pr: GhPr; task: Task | null }[] = [];

    for (const [repoName, rc] of targetRepos) {
      const ghRepo = rc.github || `${rc.org}/${repoName}`;
      const result = Bun.spawnSync([
        "gh", "pr", "list",
        "--repo", ghRepo,
        "--state", "open",
        "--json", "number,title,headRefName,isDraft,reviewDecision,url",
        "--limit", "100",
      ]);

      if (result.exitCode !== 0) {
        ui.warn(`Failed to fetch PRs for ${ghRepo}: ${result.stderr.toString().trim()}`);
        continue;
      }

      let prs: GhPr[];
      try {
        prs = JSON.parse(result.stdout.toString());
      } catch {
        ui.warn(`Invalid JSON from gh for ${ghRepo}`);
        continue;
      }

      // Filter to grove/ branch prefix
      const grovePrs = prs.filter((pr) => pr.headRefName.startsWith("grove/"));

      for (const pr of grovePrs) {
        // Cross-reference with tasks DB
        const task = db.get<Task>(
          "SELECT * FROM tasks WHERE pr_number = ? AND repo = ?",
          [pr.number, repoName],
        ) ?? db.get<Task>(
          "SELECT * FROM tasks WHERE branch = ?",
          [pr.headRefName],
        );

        allPrs.push({ repoName, pr, task });
      }
    }

    if (allPrs.length === 0) {
      ui.info("No open Grove PRs found.");
      return;
    }

    // Table header
    console.log(
      `${ui.bold(ui.pad("PR#", 7))} ${ui.bold(ui.pad("REPO", 14))} ${ui.bold(ui.pad("TITLE", 36))} ${ui.bold(ui.pad("STATUS", 12))} ${ui.bold("TASK")}`,
    );
    console.log(
      `${"-------"} ${"-------------- "}${"------------------------------------"} ${"------------ "}${"--------"}`,
    );

    for (const { repoName, pr, task } of allPrs) {
      const prNum = `#${pr.number}`;
      const title = ui.truncate(pr.title, 34);
      const badge = prStatusBadge(pr);
      const badgeVisible = pr.isDraft ? 7 : pr.reviewDecision === "APPROVED" ? 10 : pr.reviewDecision === "CHANGES_REQUESTED" ? 9 : 6;
      const badgePad = badge + " ".repeat(Math.max(1, 12 - badgeVisible));
      const taskId = task?.id ?? ui.dim("-");

      console.log(
        `${ui.pad(prNum, 7)} ${ui.pad(repoName, 14)} ${ui.pad(title, 36)} ${badgePad}${taskId}`,
      );
    }

    console.log(`\n${ui.dim(`${allPrs.length} PR(s) found`)}`);
  },

  help() {
    return [
      "Usage: grove prs [--repo NAME]",
      "",
      "List all open PRs on grove/ branches across configured repos.",
      "",
      "Options:",
      "  --repo, -r NAME    Filter to a specific repo",
      "",
      "Shows PR number, repo, title, status badge (draft/approved/changes/open),",
      "and linked task ID from the Grove database.",
    ].join("\n");
  },
};
