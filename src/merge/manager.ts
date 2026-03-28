// Grove v3 — Merge Manager: PR lifecycle management
// Handles: push branch → create PR → watch CI → merge on green
// On CI failure, sends the task back to a worker with failure context to fix and re-push.
import { bus } from "../broker/event-bus";
import { ghPrCreate, ghPrMerge, ghPrChecks, ghPrCheckDetails, ghPrEditTitle, gitPush, type PrCheckStatus } from "./github";
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

  // 2. Create PR (or reuse existing one)
  // Re-read task to get latest pr_number (may already have a PR from a previous attempt)
  const freshTask = db.taskGet(task.id) ?? task;
  let prNumber = freshTask.pr_number ?? 0;
  let prUrl = freshTask.pr_url ?? "";

  if (!prNumber) {
    try {
      const filesModified = freshTask.files_modified?.split("\n").filter(Boolean).length ?? 0;
      const gateResults = freshTask.gate_results ? JSON.parse(freshTask.gate_results) : [];
      const gatesSummary = gateResults
        .map((g: any) => `- ${g.gate}: ${g.passed ? "passed" : "FAILED"} — ${g.message}`)
        .join("\n");

      const titleSlug = freshTask.title.length > 60
        ? freshTask.title.slice(0, 60).replace(/\s+\S*$/, "...")
        : freshTask.title;
      const prTitle = `feat(${freshTask.id}): ${titleSlug}`;

      const body = [
        `## ${freshTask.title}`,
        "",
        freshTask.description ?? "",
        "",
        `**Task:** ${freshTask.id}`,
        `**Path:** ${freshTask.path_name}`,
        `**Cost:** $${freshTask.cost_usd.toFixed(2)}`,
        `**Files changed:** ${filesModified}`,
        "",
        "### Quality Gates",
        gatesSummary || "No gates run",
        "",
        "---",
        "*Created by [Grove](https://grove.cloud)*",
      ].join("\n");

      const treeConfig = tree.config ? JSON.parse(tree.config) : {};
      const baseBranch = treeConfig.default_branch ?? undefined;

      const pr = ghPrCreate(tree.github!, {
        title: prTitle,
        body,
        head: freshTask.branch!,
        base: baseBranch,
      });

      prNumber = pr.number;
      prUrl = pr.url;

      db.run("UPDATE tasks SET pr_url = ?, pr_number = ? WHERE id = ?", [prUrl, prNumber, freshTask.id]);
      db.addEvent(freshTask.id, null, "pr_created", `PR #${prNumber} created`);
      bus.emit("merge:pr_created", { taskId: freshTask.id, prNumber, prUrl });
    } catch (err: any) {
      db.addEvent(freshTask.id, null, "merge_failed", `PR creation failed: ${err.message}`);
      bus.emit("merge:ci_failed", { taskId: freshTask.id, prNumber: 0 });
      return;
    }
  } else {
    // PR already exists — update title to latest format and re-check CI
    const titleSlug = freshTask.title.length > 60
      ? freshTask.title.slice(0, 60).replace(/\s+\S*$/, "...")
      : freshTask.title;
    ghPrEditTitle(tree.github!, prNumber, `feat(${freshTask.id}): ${titleSlug}`);
    db.addEvent(freshTask.id, null, "ci_recheck", `Re-checking CI on existing PR #${prNumber}`);
  }

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
    // CI failed — get failure details and send back to worker for fixes
    const failDetails = ghPrCheckDetails(tree.github!, prNumber);
    const failSummary = failDetails.length > 0
      ? failDetails.map(c => `- ${c.name}: ${c.conclusion} (${c.link})`).join("\n")
      : `CI failed on PR #${prNumber} (no details available)`;

    db.addEvent(task.id, null, "ci_failed", `CI failed on PR #${prNumber}: ${failDetails.length} check(s) failed`);
    bus.emit("merge:ci_failed", { taskId: task.id, prNumber });

    // Check retry budget
    const maxRetries = db.get<{ max_retries: number }>(
      "SELECT max_retries FROM tasks WHERE id = ?", [task.id]
    )?.max_retries ?? 2;

    if ((task.retry_count ?? 0) >= maxRetries + 3) {
      // Too many retries — give up
      db.taskSetStatus(task.id, "ci_failed");
      db.addEvent(task.id, null, "retry_exhausted", `CI fix retries exhausted`);
      return;
    }

    // Store CI failure context so the worker knows what to fix
    db.run(
      "UPDATE tasks SET session_summary = COALESCE(session_summary, '') || ? WHERE id = ?",
      [`\n\n## CI Failure (PR #${prNumber})\n${failSummary}\n\nFix these CI failures, commit, and the PR will be re-checked automatically.`, task.id]
    );

    // Send back to worker
    db.run("UPDATE tasks SET status = 'ready', retry_count = retry_count + 1 WHERE id = ?", [task.id]);
    db.addEvent(task.id, null, "ci_fix_dispatched", `Sent back to worker to fix ${failDetails.length} CI failure(s)`);

    const { enqueue } = await import("../broker/dispatch");
    enqueue(task.id);
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
