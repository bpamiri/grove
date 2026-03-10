// grove review — Interactive PR review workflow
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { EventType, TaskStatus } from "../types";
import type { Command, Task } from "../types";

interface GhPr {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  url: string;
}

export const reviewCommand: Command = {
  name: "review",
  description: "Interactive PR review workflow",

  async run(args: string[]) {
    if (args.includes("-h") || args.includes("--help")) {
      console.log(this.help!());
      return;
    }

    const db = getDb();
    const repoConfigs = configRepoDetail();
    const repos = Object.entries(repoConfigs);

    if (repos.length === 0) {
      ui.die("No repos configured.");
    }

    // Collect all Grove PRs
    const prList: { repoName: string; ghRepo: string; pr: GhPr; task: Task | null }[] = [];

    ui.info("Fetching PRs...");

    for (const [repoName, rc] of repos) {
      const ghRepo = rc.github || `${rc.org}/${repoName}`;
      const result = Bun.spawnSync([
        "gh", "pr", "list",
        "--repo", ghRepo,
        "--state", "open",
        "--json", "number,title,headRefName,isDraft,reviewDecision,url",
        "--limit", "100",
      ]);

      if (result.exitCode !== 0) continue;

      let prs: GhPr[];
      try {
        prs = JSON.parse(result.stdout.toString());
      } catch {
        continue;
      }

      for (const pr of prs.filter((p) => p.headRefName.startsWith("grove/"))) {
        const task = db.get<Task>(
          "SELECT * FROM tasks WHERE pr_number = ? AND repo = ?",
          [pr.number, repoName],
        ) ?? db.get<Task>(
          "SELECT * FROM tasks WHERE branch = ?",
          [pr.headRefName],
        );
        prList.push({ repoName, ghRepo, pr, task });
      }
    }

    if (prList.length === 0) {
      ui.info("No open Grove PRs to review.");
      return;
    }

    // Display selection menu
    const prIndex = await prompts.numberedMenu(
      "\nSelect a PR to review:",
      prList.map(({ repoName, pr, task }) => {
        const taskStr = task ? ` (${task.id})` : "";
        return `#${pr.number} ${repoName} — ${ui.truncate(pr.title, 40)}${taskStr}`;
      }),
    );

    const selected = prList[prIndex];
    const { ghRepo, pr, task } = selected;

    // Review submenu loop
    while (true) {
      console.log();
      console.log(`PR #${pr.number}: ${ui.bold(pr.title)}`);
      console.log(`  ${ui.dim(pr.url)}`);
      if (task) console.log(`  Task: ${task.id} ${ui.statusBadge(task.status)}`);
      console.log();
      console.log("  [o] Open in browser  [d] Diff  [a] Approve  [m] Merge  [c] Comment  [q] Quit");

      const rl = await import("node:readline");
      const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
      const action = await new Promise<string>((resolve) => {
        iface.question("Action: ", (answer) => {
          iface.close();
          resolve(answer.trim().toLowerCase());
        });
      });

      if (action === "q" || action === "quit") {
        break;
      }

      if (action === "o" || action === "open") {
        Bun.spawnSync(["gh", "pr", "view", "--web", "--repo", ghRepo, String(pr.number)]);
        ui.success("Opened in browser.");
      } else if (action === "d" || action === "diff") {
        const diff = Bun.spawnSync(["gh", "pr", "diff", "--repo", ghRepo, String(pr.number)]);
        if (diff.exitCode === 0) {
          console.log(diff.stdout.toString());
        } else {
          ui.error("Failed to fetch diff.");
        }
      } else if (action === "a" || action === "approve") {
        const res = Bun.spawnSync([
          "gh", "pr", "review", "--approve", "--repo", ghRepo, String(pr.number),
        ]);
        if (res.exitCode === 0) {
          ui.success("PR approved.");
          if (task) {
            db.addEvent(task.id, EventType.AutoApproved, `PR #${pr.number} approved`);
          }
        } else {
          ui.error(`Approve failed: ${res.stderr.toString().trim()}`);
        }
      } else if (action === "m" || action === "merge") {
        const confirm = await prompts.confirm(`Merge PR #${pr.number}?`);
        if (!confirm) continue;

        const res = Bun.spawnSync([
          "gh", "pr", "merge", "--squash", "--repo", ghRepo, String(pr.number),
        ]);
        if (res.exitCode === 0) {
          ui.success(`PR #${pr.number} merged.`);
          // Auto-mark linked task as completed
          if (task) {
            db.taskSetStatus(task.id, TaskStatus.Completed);
            db.taskSet(task.id, "completed_at", new Date().toISOString());
            db.addEvent(task.id, EventType.Completed, `Task completed via PR #${pr.number} merge`);
            ui.success(`Task ${task.id} marked as completed.`);
          }
        } else {
          ui.error(`Merge failed: ${res.stderr.toString().trim()}`);
        }
        break;
      } else if (action === "c" || action === "comment") {
        const body = await prompts.text("Comment:", { placeholder: "Your review comment..." });
        if (body.trim()) {
          const res = Bun.spawnSync([
            "gh", "pr", "comment", "--repo", ghRepo, String(pr.number), "--body", body,
          ]);
          if (res.exitCode === 0) {
            ui.success("Comment posted.");
          } else {
            ui.error(`Comment failed: ${res.stderr.toString().trim()}`);
          }
        }
      } else {
        ui.warn("Unknown action. Use [o]pen, [d]iff, [a]pprove, [m]erge, [c]omment, or [q]uit.");
      }
    }
  },

  help() {
    return [
      "Usage: grove review",
      "",
      "Interactive PR review workflow for Grove-managed PRs.",
      "",
      "Collects all open PRs on grove/ branches, lets you select one,",
      "then provides a review submenu:",
      "",
      "  [o] Open in browser",
      "  [d] View diff",
      "  [a] Approve PR",
      "  [m] Merge PR (auto-marks linked task as completed)",
      "  [c] Add a comment",
      "  [q] Quit",
    ].join("\n");
  },
};
