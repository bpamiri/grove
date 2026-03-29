// Grove v3 — Merge Manager: PR lifecycle management
// Handles: push branch → create PR → watch CI → merge on green
// Sequential per-tree queue to avoid merge conflicts.
import { bus } from "../broker/event-bus";
import {
  ghPrCreate, ghPrMerge, ghPrChecks, ghPrMergeable,
  gitPush, gitPushForce, gitRebase,
  type PrCheckStatus, type MergeableState,
} from "./github";
import type { Database } from "../broker/db";
import type { Task, Tree, TreeConfig } from "../shared/types";

// Per-tree merge queue (sequential to avoid conflicts)
const mergeQueues = new Map<string, Promise<void>>();

/** Extract default_branch from tree config JSON, falling back to "main" */
export function treeDefaultBranch(tree: Tree): string {
  try {
    const cfg = JSON.parse(tree.config || "{}") as Partial<TreeConfig>;
    return cfg.default_branch || "main";
  } catch {
    return "main";
  }
}

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

  // 3. Check for merge conflicts (one rebase attempt if conflicting)
  const baseBranch = treeDefaultBranch(tree);
  const postCreateState = await waitForMergeable(tree.github, prNumber);
  if (postCreateState === "CONFLICTING") {
    const resolved = await attemptRebase(task, tree.github, prNumber, db, baseBranch);
    if (!resolved) {
      db.taskSetStatus(task.id, "conflict");
      db.addEvent(task.id, null, "conflict_detected", `Conflict on PR #${prNumber} — auto-rebase failed`);
      bus.emit("merge:rebase_failed", { taskId: task.id, prNumber });
      return;
    }
  }

  // 4. Watch CI
  const ciResult = await watchCI(tree.github, prNumber, task.id, db);

  if (ciResult.state === "success") {
    // 5. Pre-merge conflict check (branch may have drifted during CI)
    const preMergeState = await waitForMergeable(tree.github, prNumber);
    if (preMergeState === "CONFLICTING") {
      db.taskSetStatus(task.id, "conflict");
      db.addEvent(task.id, null, "conflict_detected", `Conflict appeared during CI on PR #${prNumber}`);
      bus.emit("merge:conflict_detected", { taskId: task.id, prNumber });
      return;
    }

    // 6. Merge
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

/** Poll GitHub until mergeable state is computed (not UNKNOWN) */
async function waitForMergeable(
  repo: string,
  prNumber: number,
  maxAttempts: number = 3,
  intervalMs: number = 5_000,
): Promise<MergeableState> {
  for (let i = 0; i < maxAttempts; i++) {
    const state = ghPrMergeable(repo, prNumber);
    if (state !== "UNKNOWN") return state;
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  // GitHub hasn't resolved yet — treat as mergeable and proceed
  return "MERGEABLE";
}

/** Attempt to rebase the task branch onto the base branch and force-push */
async function attemptRebase(
  task: Task,
  repo: string,
  prNumber: number,
  db: Database,
  baseBranch: string = "main",
): Promise<boolean> {
  if (!task.worktree_path || !task.branch) return false;

  db.addEvent(task.id, null, "rebase_started", `Conflict detected on PR #${prNumber}, attempting rebase onto ${baseBranch}`);

  const rebaseResult = gitRebase(task.worktree_path, baseBranch);
  if (!rebaseResult.ok) {
    db.addEvent(task.id, null, "rebase_failed", `Rebase failed: ${rebaseResult.stderr}`);
    return false;
  }

  if (rebaseResult.autoResolved?.length) {
    db.addEvent(task.id, null, "conflict_auto_resolved",
      `Auto-resolved trivial conflicts: ${rebaseResult.autoResolved.join(", ")}`);
  }

  const pushResult = gitPushForce(task.worktree_path, task.branch);
  if (!pushResult.ok) {
    db.addEvent(task.id, null, "rebase_failed", `Force push after rebase failed: ${pushResult.stderr}`);
    return false;
  }

  // Wait for GitHub to recompute mergeable after force push
  const afterState = await waitForMergeable(repo, prNumber);
  if (afterState === "CONFLICTING") {
    db.addEvent(task.id, null, "rebase_failed", "Still conflicting after rebase");
    return false;
  }

  db.addEvent(task.id, null, "rebase_succeeded", `Rebase resolved conflict on PR #${prNumber}`);
  bus.emit("merge:rebase_succeeded", { taskId: task.id, prNumber });
  return true;
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
