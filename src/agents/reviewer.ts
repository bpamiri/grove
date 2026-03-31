// Grove v3 — Reviewer agent: adversarial plan review via Claude Code sessions
// Spawns a read-only Claude session that critiques worker output (plans).
// Returns structured pass/fail with feedback for the plan-review loop.
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { parseCost } from "./stream-parser";
import { deployReviewSandbox, reviewTriggerPrompt } from "../shared/sandbox";
import type { ReviewOverlayContext } from "../shared/sandbox";
import type { Database } from "../broker/db";
import type { Task, Tree } from "../shared/types";

export interface ReviewResult {
  approved: boolean;
  feedback: string;
  fatal?: boolean;
  costUsd: number;
}

/** Default max review iterations before marking the task as fatally failed */
export const DEFAULT_MAX_REVIEW_RETRIES = 3;

/**
 * Spawn a reviewer agent for a task. Reads the plan from the worktree,
 * spawns a read-only Claude session to critique it, and reports the result.
 */
export function spawnReviewer(
  task: Task,
  tree: Tree,
  db: Database,
  logDir: string,
  stepPrompt?: string,
  maxRetries?: number,
): void {
  mkdirSync(logDir, { recursive: true });

  const sessionId = `reviewer-${task.id}-${Date.now()}`;
  const logPath = join(logDir, `${sessionId}.jsonl`);

  const worktreePath = task.worktree_path;
  if (!worktreePath || !existsSync(worktreePath)) {
    db.addEvent(task.id, null, "review_rejected", "Worktree not found — cannot review");
    bus.emit("review:rejected", { taskId: task.id, feedback: "Worktree not found" });
    // Defer onStepComplete to avoid synchronous re-entry
    setTimeout(async () => {
      const { onStepComplete } = await import("../engine/step-engine");
      onStepComplete(task.id, "failure", "Worktree not found — cannot review");
    }, 0);
    return;
  }

  // Check if we've exceeded max review iterations
  const maxIter = maxRetries ?? DEFAULT_MAX_REVIEW_RETRIES;
  const prevRejections = db.scalar<number>(
    "SELECT COUNT(*) FROM events WHERE task_id = ? AND event_type = 'review_rejected'",
    [task.id],
  ) ?? 0;

  if (prevRejections >= maxIter) {
    db.addEvent(task.id, null, "review_rejected",
      `Review loop exhausted (${prevRejections}/${maxIter} rejections) — plan not approved`);
    bus.emit("review:rejected", { taskId: task.id, feedback: "Review loop exhausted" });
    setTimeout(async () => {
      const { onStepComplete } = await import("../engine/step-engine");
      onStepComplete(task.id, "fatal", `Plan not approved after ${prevRejections} review cycles — manual intervention required`);
    }, 0);
    return;
  }

  // Read the plan from the worktree
  const planContent = readPlanContent(worktreePath, task.session_summary);
  if (!planContent) {
    db.addEvent(task.id, null, "review_rejected", "No plan found in worktree");
    bus.emit("review:rejected", { taskId: task.id, feedback: "No plan found" });
    setTimeout(async () => {
      const { onStepComplete } = await import("../engine/step-engine");
      onStepComplete(task.id, "failure", "No plan found in worktree — nothing to review");
    }, 0);
    return;
  }

  // Gather prior review feedback for context threading
  const priorFeedback = getPriorReviewFeedback(db, task.id);

  // Deploy review sandbox (read-only guard hooks + review CLAUDE.md overlay)
  const reviewCtx: ReviewOverlayContext = {
    taskId: task.id,
    title: task.title,
    description: task.description,
    treePath: tree.path,
    stepPrompt,
    planContent,
    priorFeedback,
  };
  deployReviewSandbox(worktreePath, reviewCtx);

  // Register session
  db.sessionCreate(sessionId, task.id, "reviewer", undefined, undefined, logPath);
  db.addEvent(task.id, sessionId, "review_started", `Review started (iteration ${prevRejections + 1}/${maxIter})`);
  bus.emit("review:started", { taskId: task.id, sessionId });

  const prompt = reviewTriggerPrompt(task.id);

  // Spawn Claude CLI in the worktree (read-only via guard hooks)
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    {
      cwd: worktreePath,
      env: {
        ...process.env,
        GROVE_TASK_ID: task.id,
        GROVE_WORKTREE_PATH: worktreePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  db.addEvent(task.id, sessionId, "worker_spawned", `Reviewer spawned (PID: ${proc.pid})`);

  // Monitor asynchronously
  monitorReviewer(task.id, sessionId, logPath, worktreePath, proc, db);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Read plan content from worktree — tries .grove/plan.md then session summary */
export function readPlanContent(worktreePath: string, sessionSummary?: string | null): string | null {
  const planPath = join(worktreePath, ".grove", "plan.md");
  if (existsSync(planPath)) {
    try {
      const content = readFileSync(planPath, "utf-8").trim();
      if (content) return content;
    } catch {}
  }

  // Fall back to session summary (planner may have written plan context there)
  if (sessionSummary?.trim()) return sessionSummary;

  return null;
}

/** Parse the review result from .grove/review-result.json */
export function parseReviewResult(worktreePath: string): ReviewResult | null {
  const resultPath = join(worktreePath, ".grove", "review-result.json");
  if (!existsSync(resultPath)) return null;

  try {
    const raw = readFileSync(resultPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      approved: Boolean(parsed.approved),
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "No feedback provided",
      costUsd: 0,
    };
  } catch {
    return null;
  }
}

/** Get prior review feedback from event history */
export function getPriorReviewFeedback(db: Database, taskId: string): string[] {
  const events = db.all<{ summary: string }>(
    "SELECT summary FROM events WHERE task_id = ? AND event_type = 'review_rejected' ORDER BY created_at ASC",
    [taskId],
  );
  return events.map((e) => e.summary).filter(Boolean);
}

/** Write review feedback to worktree for the next planner iteration */
function writeReviewFeedback(worktreePath: string, feedback: string): void {
  const feedbackPath = join(worktreePath, ".grove", "review-feedback.md");
  writeFileSync(feedbackPath, feedback);
}

/** Remove the review result file so it doesn't persist across iterations */
function cleanupReviewResult(worktreePath: string): void {
  const resultPath = join(worktreePath, ".grove", "review-result.json");
  try { if (existsSync(resultPath)) Bun.spawnSync(["rm", resultPath]); } catch {}
}

/** Monitor a reviewer's stdout and handle completion */
async function monitorReviewer(
  taskId: string,
  sessionId: string,
  logPath: string,
  worktreePath: string,
  proc: ReturnType<typeof Bun.spawn>,
  db: Database,
): Promise<void> {
  try {
    // Read stdout and write to log
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("Reviewer stdout not available");
    }
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const logFile = Bun.file(logPath);
    const writer = logFile.writer();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value);
      writer.write(text);
      writer.flush();

      // Parse activity events for UI
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "assistant") {
            for (const block of obj.message?.content ?? []) {
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                bus.emit("worker:activity", { taskId, msg: `[reviewer] ${tool}: ${String(file).slice(0, 200)}` });
              }
            }
          }
          if (obj.type === "result" && obj.cost_usd != null) {
            db.sessionUpdateCost(sessionId, Number(obj.cost_usd), Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0));
          }
        } catch {}
      }
    }

    writer.end();

    // Wait for exit
    const exitCode = await proc.exited;

    // Parse cost
    const cost = parseCost(logPath);
    db.sessionUpdateCost(sessionId, cost.costUsd, cost.inputTokens + cost.outputTokens);
    db.run("UPDATE tasks SET cost_usd = cost_usd + ?, tokens_used = tokens_used + ? WHERE id = ?",
      [cost.costUsd, cost.inputTokens + cost.outputTokens, taskId]);

    // Read structured result
    const result = parseReviewResult(worktreePath);

    if (!result || !result.approved) {
      const feedback = result?.feedback ?? `Reviewer exited with code ${exitCode} without writing a verdict`;

      // Persist feedback for the planner's next iteration
      writeReviewFeedback(worktreePath, feedback);
      cleanupReviewResult(worktreePath);

      db.sessionEnd(sessionId, "failed");
      db.addEvent(taskId, sessionId, "review_rejected", feedback);
      bus.emit("review:rejected", { taskId, feedback });

      const { onStepComplete } = await import("../engine/step-engine");
      onStepComplete(taskId, "failure", feedback);
    } else {
      cleanupReviewResult(worktreePath);

      db.sessionEnd(sessionId, "completed");
      db.addEvent(taskId, sessionId, "review_approved", result.feedback || "Plan approved");
      bus.emit("review:approved", { taskId, feedback: result.feedback });

      const { onStepComplete } = await import("../engine/step-engine");
      onStepComplete(taskId, "success");
    }
  } catch (err) {
    db.sessionEnd(sessionId, "crashed");
    db.addEvent(taskId, sessionId, "review_rejected", `Reviewer crashed: ${err}`);
    bus.emit("review:rejected", { taskId, feedback: `Reviewer crashed: ${err}` });

    const { onStepComplete } = await import("../engine/step-engine");
    onStepComplete(taskId, "failure", `Reviewer crashed: ${err}`);
  }
}
