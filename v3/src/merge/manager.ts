// Grove v3 — Merge Manager: PR lifecycle management
// Handles: push branch → create PR → watch CI → merge on green
// Sequential per-tree queue to avoid merge conflicts.
import { bus } from "../broker/event-bus";
import { ghPrCreate, ghPrMerge, ghPrChecks, gitPush, type PrCheckStatus } from "./github";
import type { Database } from "../broker/db";
import type { Task, Tree } from "../shared/types";

// Per-tree merge queue (sequential to avoid conflicts)
const mergeQueues = new Map<string, Promise<void>>();

/** Queue a task for PR creation, CI watch, and merge */
export function queueMerge(task: Task, tree: Tree, db: Database): void {
  const treeId = tree.id;

  // Chain onto the existing queue for this tree
  const prev = mergeQueues.get(treeId) ?? Promise.resolve();
  const next = prev.then(() => processMerge(task, tree, db)).catch((err) => {
    db.addEvent(task.id, null, "merge_failed", `Merge failed: ${err.message}`);
  });
  mergeQueues.set(treeId, next);
}

async function processMerge(task: Task, tree: Tree, db: Database): Promise<void> {
  if (!task.worktree_path || !task.branch) {
    db.addEvent(task.id, null, "merge_failed", "No worktree or branch");
    return;
  }

  if (!tree.github) {
    db.addEvent(task.id, null, "merge_failed", "No GitHub repo configured for tree");
    return;
  }

  // 1. Push the branch
  const pushResult = gitPush(task.worktree_path, task.branch);
  if (!pushResult.ok) {
    db.addEvent(task.id, null, "merge_failed", `Push failed: ${pushResult.stderr}`);
    bus.emit("merge:ci_failed", { taskId: task.id, prNumber: 0 });
    return;
  }

  // 2. Create PR
  let prNumber: number;
  let prUrl: string;
  try {
    const filesModified = task.files_modified?.split("\n").filter(Boolean).length ?? 0;
    const gateResults = task.gate_results ? JSON.parse(task.gate_results) : [];
    const gatesSummary = gateResults
      .map((g: any) => `- ${g.gate}: ${g.passed ? "passed" : "FAILED"} — ${g.message}`)
      .join("\n");

    const body = [
      `## ${task.title}`,
      "",
      task.description ?? "",
      "",
      `**Task:** ${task.id}`,
      `**Path:** ${task.path_name}`,
      `**Cost:** $${task.cost_usd.toFixed(2)}`,
      `**Files changed:** ${filesModified}`,
      "",
      "### Quality Gates",
      gatesSummary || "No gates run",
      "",
      "---",
      "*Created by [Grove](https://grove.cloud)*",
    ].join("\n");

    const pr = ghPrCreate(tree.github, {
      title: `grove(${task.id}): ${task.title}`,
      body,
      head: task.branch,
    });

    prNumber = pr.number;
    prUrl = pr.url;
  } catch (err: any) {
    db.addEvent(task.id, null, "merge_failed", `PR creation failed: ${err.message}`);
    bus.emit("merge:ci_failed", { taskId: task.id, prNumber: 0 });
    return;
  }

  // Update task with PR info
  db.run("UPDATE tasks SET pr_url = ?, pr_number = ? WHERE id = ?", [prUrl, prNumber, task.id]);
  db.addEvent(task.id, null, "pr_created", `PR #${prNumber} created`);
  bus.emit("merge:pr_created", { taskId: task.id, prNumber, prUrl });

  // 3. Watch CI
  const ciResult = await watchCI(tree.github, prNumber, task.id, db);

  if (ciResult.state === "success") {
    // 4. Merge
    try {
      ghPrMerge(tree.github, prNumber);
      db.taskSetStatus(task.id, "merged");
      db.run("UPDATE tasks SET completed_at = datetime('now') WHERE id = ?", [task.id]);
      db.addEvent(task.id, null, "pr_merged", `PR #${prNumber} merged`);
      bus.emit("merge:completed", { taskId: task.id, prNumber });
    } catch (err: any) {
      db.addEvent(task.id, null, "merge_failed", `Merge failed: ${err.message}`);
      bus.emit("merge:ci_failed", { taskId: task.id, prNumber });
    }
  } else {
    // CI failed — notify orchestrator
    db.taskSetStatus(task.id, "ci_failed");
    db.addEvent(task.id, null, "ci_failed", `CI failed on PR #${prNumber}`);
    bus.emit("merge:ci_failed", { taskId: task.id, prNumber });
  }
}

/** Poll CI checks until all pass, fail, or timeout */
async function watchCI(
  repo: string,
  prNumber: number,
  taskId: string,
  db: Database,
  maxWaitMs: number = 10 * 60 * 1000, // 10 minutes
  pollIntervalMs: number = 15_000,
): Promise<PrCheckStatus> {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = ghPrChecks(repo, prNumber);

    if (status.state === "success") {
      db.addEvent(taskId, null, "ci_passed", `CI passed (${status.passing}/${status.total} checks)`);
      bus.emit("merge:ci_passed", { taskId, prNumber });
      return status;
    }

    if (status.state === "failure") {
      return status;
    }

    // Still pending — wait and retry
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout — treat as failure
  return { state: "failure", total: 0, passing: 0, failing: 0, pending: 0 };
}
