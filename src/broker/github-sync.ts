// Grove v3 — Auto-create GitHub issues when tasks are created
import { bus } from "./event-bus";
import type { Database } from "./db";

/** Format the GitHub issue body for a Grove task */
export function formatIssueBody(task: { id: string; description: string | null; path_name: string }): string {
  const desc = task.description || "No description provided.";
  return [
    desc,
    "",
    `**Task:** ${task.id}`,
    `**Path:** ${task.path_name}`,
    "",
    "*Delivered by [Grove](https://grove.cloud)*",
  ].join("\n");
}

/**
 * Attempt to create a GitHub issue for a task.
 * Returns the issue number on success, or null if skipped/failed.
 */
export function createIssueForTask(
  db: Database,
  taskId: string,
  ghIssueCreate: (repo: string, opts: { title: string; body: string }) => { number: number; url: string },
): number | null {
  const task = db.taskGet(taskId);
  if (!task) return null;

  // Skip if already has an issue (e.g. imported from GitHub)
  if (task.github_issue) return null;

  // Skip if no tree assigned
  if (!task.tree_id) return null;

  const tree = db.treeGet(task.tree_id);
  if (!tree || !tree.github) return null;

  try {
    const body = formatIssueBody(task);
    const { number } = ghIssueCreate(tree.github, { title: task.title, body });
    db.run("UPDATE tasks SET github_issue = ? WHERE id = ?", [number, task.id]);
    db.addEvent(task.id, null, "issue_created", `GitHub issue #${number} created on ${tree.github}`);
    return number;
  } catch (err: any) {
    db.addEvent(task.id, null, "issue_create_failed", `Failed to create GitHub issue: ${err.message}`);
    return null;
  }
}

/** Wire the event listener — call once at broker startup */
export function wireGitHubSync(db: Database): void {
  const { ghIssueCreate } = require("../merge/github");

  bus.on("task:created", ({ task }) => {
    createIssueForTask(db, task.id, ghIssueCreate);
  });
}
