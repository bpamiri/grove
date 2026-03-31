// Grove v3 — PR poller: auto-import contributed PRs for review
import { bus } from "../broker/event-bus";
import type { Database } from "../broker/db";
import type { Tree } from "../shared/types";

interface PrReviewConfig {
  enabled: boolean;
  poll_interval: number;
  auto_dispatch: boolean;
  prompt?: string;
}

/** Parse pr_review config from tree config JSON */
export function parsePrReviewConfig(treeConfig: string | null): PrReviewConfig | null {
  if (!treeConfig) return null;
  try {
    const parsed = JSON.parse(treeConfig);
    const pr = parsed.pr_review;
    if (!pr?.enabled) return null;
    return {
      enabled: true,
      poll_interval: pr.poll_interval ?? 300,
      auto_dispatch: pr.auto_dispatch ?? false,
      prompt: pr.prompt,
    };
  } catch { return null; }
}

/** Filter PRs — exclude those with branches matching the grove prefix */
export function filterExternalPRs<T extends { headRefName: string }>(
  prs: T[],
  branchPrefix: string,
): T[] {
  return prs.filter(pr => !pr.headRefName.startsWith(branchPrefix));
}

/** Import a single PR as a draft task. Returns task ID or null if already imported. */
export function importPr(
  db: Database,
  tree: Tree,
  pr: { number: number; title: string; body?: string; headRefName: string },
): string | null {
  // Check if already imported
  const existing = db.get<{ id: string }>(
    "SELECT id FROM tasks WHERE tree_id = ? AND source_pr = ?",
    [tree.id, pr.number],
  );
  if (existing) return null;

  const taskId = db.nextTaskId("W");
  db.run(
    "INSERT INTO tasks (id, tree_id, title, description, path_name, status, source_pr) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
    [taskId, tree.id, `PR #${pr.number}: ${pr.title}`, pr.body ?? "", "pr-review", pr.number],
  );
  db.addEvent(taskId, null, "task_created", `Imported from ${tree.github} PR #${pr.number}`);
  bus.emit("task:created", { task: db.taskGet(taskId)! });
  return taskId;
}

let _interval: ReturnType<typeof setInterval> | null = null;

/** Start polling for new PRs on all configured trees */
export function startPrPoller(db: Database): void {
  if (_interval) return;

  const poll = async () => {
    const trees = db.all<Tree>("SELECT * FROM trees WHERE github IS NOT NULL");
    for (const tree of trees) {
      const config = parsePrReviewConfig(tree.config);
      if (!config) continue;

      try {
        const { ghPrList } = await import("../merge/github");
        const prs = ghPrList(tree.github!, { state: "open", limit: 50 });
        const external = filterExternalPRs(prs, tree.branch_prefix);

        for (const pr of external) {
          const taskId = importPr(db, tree, pr);
          if (taskId && config.auto_dispatch) {
            const { enqueue } = await import("../broker/dispatch");
            db.taskSetStatus(taskId, "queued");
            enqueue(taskId);
          }
        }
      } catch (err: any) {
        db.addEvent(null, null, "pr_poll_error", `PR poll failed for ${tree.github}: ${err.message}`);
      }
    }
  };

  poll();
  _interval = setInterval(poll, 300_000);
}

/** Stop the PR poller */
export function stopPrPoller(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
