// Grove v3 — Issue-status poller: sync task status from GitHub issue closure
import { bus } from "./event-bus";
import type { Database } from "./db";

let _interval: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL = 300_000; // 5 minutes

/** Start polling GitHub for closed issues and update local task status */
export function startIssuePoller(db: Database): void {
  if (_interval) return;

  const poll = async () => {
    const rows = db.tasksWithOpenIssues();
    if (rows.length === 0) return;

    // Group by repo to batch API calls
    const byRepo = new Map<string, Array<{ task_id: string; github_issue: number }>>();
    for (const row of rows) {
      const list = byRepo.get(row.github) ?? [];
      list.push({ task_id: row.task_id, github_issue: row.github_issue });
      byRepo.set(row.github, list);
    }

    for (const [repo, tasks] of byRepo) {
      try {
        const { ghIssueStatuses } = await import("../shared/github");
        const issueNumbers = tasks.map(t => t.github_issue);
        const statuses = ghIssueStatuses(repo, issueNumbers);

        for (const task of tasks) {
          const state = statuses.get(task.github_issue);
          if (state === "CLOSED") {
            db.run(
              "UPDATE tasks SET status = 'closed', completed_at = datetime('now') WHERE id = ?",
              [task.task_id],
            );
            db.addEvent(
              task.task_id,
              null,
              "status_change",
              `Status changed to closed (GitHub issue #${task.github_issue} was closed)`,
            );
            bus.emit("task:status", { taskId: task.task_id, status: "closed" });
          }
        }
      } catch (err: any) {
        db.addEvent(null, null, "issue_poll_error", `Issue poll failed for ${repo}: ${err.message}`);
      }
    }
  };

  poll();
  _interval = setInterval(poll, POLL_INTERVAL);
}

/** Stop the issue-status poller */
export function stopIssuePoller(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
