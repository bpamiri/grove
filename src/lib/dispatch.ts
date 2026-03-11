// grove dispatch helpers — shared between work.ts and drain.ts
// Extracted from src/commands/work.ts (pure refactor, no behavior change).
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, getEnv } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { pc } from "../core/ui";
import * as prompts from "../core/prompts";
import { createWorktree } from "./worktree";
import { deploySandbox, buildTriggerPrompt, buildResumeTriggerPrompt } from "./sandbox";
import { publishTask } from "../commands/publish";

/** Terminal task states — shared by batch monitor loops in work.ts and drain.ts */
export const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "review"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse stream-json log file for cost and token totals */
export function parseCosts(logFile: string): { costUsd: number; tokensUsed: number } {
  if (!existsSync(logFile)) return { costUsd: 0, tokensUsed: 0 };

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  try {
    const content = readFileSync(logFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof obj !== "object" || obj === null) continue;

      // Result type has final cost/usage
      if (obj.type === "result") {
        if (typeof obj.cost_usd === "number") totalCost = obj.cost_usd;
        const usage = obj.usage;
        if (usage && typeof usage === "object") {
          totalInput = Number(usage.input_tokens) || totalInput;
          totalOutput = Number(usage.output_tokens) || totalOutput;
        }
      } else {
        // Intermediate cost/usage updates
        if (typeof obj.cost_usd === "number") totalCost = obj.cost_usd;
        const usage = obj.usage;
        if (usage && typeof usage === "object") {
          if (typeof usage.input_tokens === "number") totalInput = usage.input_tokens;
          if (typeof usage.output_tokens === "number") totalOutput = usage.output_tokens;
        }
      }
    }
  } catch {
    // Failed to read log
  }

  return { costUsd: totalCost, tokensUsed: totalInput + totalOutput };
}

/** Read session summary from worktree's .grove/session-summary.md */
export function readSessionSummary(worktreePath: string): string | null {
  const summaryFile = join(worktreePath, ".grove", "session-summary.md");
  if (existsSync(summaryFile)) {
    try {
      return readFileSync(summaryFile, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

/** Get files modified in worktree via git diff */
export function getFilesModified(worktreePath: string): string | null {
  if (!existsSync(worktreePath)) return null;

  const diffHead = Bun.spawnSync(["git", "-C", worktreePath, "diff", "--name-only", "HEAD"]);
  const diffCached = Bun.spawnSync(["git", "-C", worktreePath, "diff", "--name-only", "--cached"]);

  const files = new Set<string>();
  const headOut = diffHead.stdout.toString().trim();
  const cachedOut = diffCached.stdout.toString().trim();

  if (headOut) for (const f of headOut.split("\n")) files.add(f);
  if (cachedOut) for (const f of cachedOut.split("\n")) files.add(f);

  if (files.size === 0) return null;
  return [...files].sort().join(", ");
}

/** Check for tasks unblocked by a completed task and notify */
export function notifyUnblocked(taskId: string): void {
  const db = getDb();
  const unblocked = db.getNewlyUnblocked(taskId);
  for (const t of unblocked) {
    db.addEvent(t.id, "dependency_met", `Unblocked by ${taskId}`);
    ui.info(`Unblocked: ${t.id} (${t.title})`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch a single task
// ---------------------------------------------------------------------------

/**
 * Dispatch a single task: budget check, worktree, prompt, spawn claude.
 * @param taskId - The task to dispatch
 * @param foreground - true = pipe to stdout + log, false = background only
 * @returns exit code (0 = success)
 */
export async function dispatchTask(taskId: string, foreground: boolean): Promise<number> {
  const db = getDb();
  const { GROVE_LOG_DIR } = getEnv();

  const task = db.taskGet(taskId);
  if (!task) {
    ui.error(`Task not found: ${taskId}`);
    return 1;
  }

  const { repo, title, status, estimated_cost } = task;

  // -- Pre-flight: dependency check --
  if (db.isTaskBlocked(taskId)) {
    const deps = (task.depends_on ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const pendingDeps = deps.filter((dep) => {
      const dt = db.taskGet(dep);
      return !dt || (dt.status !== "done" && dt.status !== "completed");
    });
    ui.warn(`Skipping ${taskId}: blocked by ${pendingDeps.join(", ")}`);
    return 1;
  }

  // -- Pre-flight: status check --
  switch (status) {
    case "ready":
      break;
    case "planned":
      ui.info(`Task ${taskId} is planned but not explicitly marked ready. Auto-approving.`);
      db.taskSetStatus(taskId, "ready");
      break;
    case "ingested": {
      ui.info(`Task ${taskId} is ingested. Auto-planning...`);
      const { planCommand } = await import("../commands/plan");
      await planCommand.run([taskId]);
      // Verify it reached ready (plan may leave it at planned if over budget)
      const updated = db.taskGet(taskId);
      if (!updated || (updated.status !== "ready" && updated.status !== "planned")) {
        ui.error(`Task ${taskId} could not be promoted to ready (status: ${updated?.status}).`);
        return 1;
      }
      if (updated.status === "planned") {
        db.taskSetStatus(taskId, "ready");
      }
      break;
    }
    case "failed":
      ui.info(`Task ${taskId} failed previously. Retrying...`);
      db.taskSetStatus(taskId, "ready");
      db.addEvent(taskId, "status_change", "Retrying failed task");
      break;
    case "paused":
      ui.info(`Task ${taskId} is paused. Using standard dispatch (use 'grove resume' for resume-specific prompting).`);
      break;
    case "running":
      ui.warn(`Task ${taskId} is already running.`);
      return 1;
    case "done":
    case "completed":
      ui.warn(`Task ${taskId} is already done.`);
      return 1;
    default:
      ui.error(`Task ${taskId} has status '${status}' — must be 'ready', 'planned', or 'ingested' to start.`);
      return 1;
  }

  // -- Pre-flight: budget check --
  const checkAmount = estimated_cost ?? 0;
  const weekCost = db.costWeek();
  const weekBudget = budgetGet("per_week");

  if (weekBudget > 0 && weekCost + checkAmount > weekBudget) {
    ui.error(`Budget exceeded. Weekly spend: ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)}`);
    if (foreground) {
      const override = await prompts.confirm("Override budget and continue?");
      if (!override) return 1;
    } else {
      ui.error(`Skipping ${taskId} (budget exceeded, non-interactive mode).`);
      return 1;
    }
  }

  // -- Pre-flight: claude command --
  const claudeCheck = Bun.spawnSync(["which", "claude"]);
  if (claudeCheck.exitCode !== 0) {
    ui.die("Required command not found: claude");
  }

  if (!repo) {
    ui.die(`Task ${taskId} has no repo assigned.`);
  }

  // -- Create worktree --
  ui.info(`Creating worktree for ${taskId} (${repo})...`);
  const wtPath = createWorktree(taskId, repo, db);
  if (!wtPath || !existsSync(wtPath)) {
    ui.die(`Failed to create worktree for ${taskId}.`);
  }
  ui.debug(`Worktree: ${wtPath}`);

  // -- Deploy sandbox (guard hooks + task overlay) --
  deploySandbox(wtPath, taskId, db);
  ui.debug("Sandbox deployed (.claude/settings.local.json + CLAUDE.md)");

  // -- Generate trigger prompt (full context is in the overlay CLAUDE.md) --
  let prompt: string;
  if (status === "paused") {
    prompt = buildResumeTriggerPrompt(taskId);
  } else {
    prompt = buildTriggerPrompt(taskId);
  }

  // -- Create session --
  const sessionId = db.sessionCreate(taskId);
  db.taskSet(taskId, "session_id", String(sessionId));

  // -- Update task status --
  db.taskSetStatus(taskId, "running");
  db.taskSet(taskId, "started_at", new Date().toISOString().replace("T", " ").slice(0, 19));

  // -- Log file --
  mkdirSync(GROVE_LOG_DIR, { recursive: true });
  const now = new Date();
  const tsSlug = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const logFile = join(GROVE_LOG_DIR, `${taskId}-${tsSlug}.log`);

  // -- Log event --
  const branch = db.taskGetField(taskId, "branch") as string;
  db.addEvent(taskId, "worker_spawned", `Worker session ${sessionId} started`, `Log: ${logFile}`);

  // -- Update session with log path --
  db.exec("UPDATE sessions SET output_log = ? WHERE id = ?", [logFile, sessionId]);

  // -- Print dispatch info --
  ui.info(`Dispatching worker for ${taskId}: ${title}`);
  console.log(`  ${ui.dim("Branch:")}  ${branch}`);
  console.log(`  ${ui.dim("Worktree:")} ${wtPath}`);
  console.log(`  ${ui.dim("Log:")}     ${logFile}`);
  console.log(`  ${ui.dim("Session:")} ${sessionId}`);
  console.log();

  // -- Spawn Claude --
  if (foreground) {
    // Foreground: spawn and pipe to both stdout and log file
    const proc = Bun.spawn(["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], {
      cwd: wtPath,
      env: { ...process.env, GROVE_TASK_ID: taskId, GROVE_WORKTREE_PATH: wtPath },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Stream stdout: write everything to log, show filtered status to console
    const logWriter = Bun.file(logFile).writer();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let toolCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        logWriter.write(value);

        // Buffer and parse line-by-line for display
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? ""; // keep incomplete last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: any;
          try { obj = JSON.parse(trimmed); } catch { continue; }
          if (!obj || typeof obj !== "object") continue;

          // Only display meaningful events
          if (obj.type === "assistant" && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === "text" && block.text) {
                // Show assistant text output
                const txt = block.text.trim();
                if (txt) console.log(`  ${pc.cyan("▸")} ${txt}`);
              } else if (block.type === "tool_use") {
                toolCount++;
                const name = block.name || "unknown";
                const desc = block.input?.description || block.input?.command || block.input?.pattern || block.input?.file_path || "";
                const short = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
                console.log(`  ${pc.yellow("⚙")} ${pc.dim(`[${toolCount}]`)} ${pc.bold(name)} ${pc.dim(short)}`);
              }
              // Skip: thinking blocks
            }
          } else if (obj.type === "result") {
            // Final result
            const cost = typeof obj.cost_usd === "number" ? ` (${ui.dollars(obj.cost_usd)})` : "";
            console.log(`  ${pc.green("●")} ${pc.bold("Session complete")}${cost}`);
          }
          // Skip: system, user (tool results), rate_limit_event, hook events
        }
      }
    } catch {
      // Stream closed
    }

    // Also capture stderr to log
    const stderrReader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        logWriter.write(value);
      }
    } catch {
      // Stream closed
    }

    await logWriter.end();
    const exitCode = await proc.exited;

    // -- Post-completion --
    console.log();
    ui.info(`Worker finished for ${taskId} (exit code: ${exitCode})`);

    // Read session summary
    const summary = readSessionSummary(wtPath);
    if (summary) {
      db.taskSet(taskId, "session_summary", summary);
      db.exec("UPDATE sessions SET summary = ? WHERE id = ?", [summary, sessionId]);
      ui.debug("Session summary captured");
    }

    // Get files modified
    const files = getFilesModified(wtPath);
    if (files) {
      db.taskSet(taskId, "files_modified", files);
      ui.debug(`Files modified: ${files}`);
    }

    // Parse cost/token info from log
    const { costUsd, tokensUsed } = parseCosts(logFile);
    if (costUsd > 0) {
      db.exec("UPDATE tasks SET cost_usd = ? WHERE id = ?", [costUsd, taskId]);
      db.exec("UPDATE sessions SET cost_usd = ? WHERE id = ?", [costUsd, sessionId]);
      ui.debug(`Cost: $${costUsd}`);
    }
    if (tokensUsed > 0) {
      db.exec("UPDATE tasks SET tokens_used = ? WHERE id = ?", [tokensUsed, taskId]);
      db.exec("UPDATE sessions SET tokens_used = ? WHERE id = ?", [tokensUsed, sessionId]);
      ui.debug(`Tokens: ${tokensUsed}`);
    }

    // Set final status
    if (exitCode === 0) {
      db.taskSetStatus(taskId, "done");
      db.sessionEnd(sessionId, "completed");
      ui.success(`Task ${taskId} completed.`);

      // Notify any tasks unblocked by this completion
      notifyUnblocked(taskId);

      // Auto-publish: push branch + create draft PR
      const published = await publishTask(taskId, db);
      if (published) {
        ui.success(`PR created for ${taskId}`);
      } else {
        ui.warn(`Auto-publish failed. Retry with: grove publish ${taskId}`);
      }
    } else {
      db.taskSetStatus(taskId, "failed");
      db.sessionEnd(sessionId, "failed");
      ui.error(`Task ${taskId} failed (exit ${exitCode}).`);
    }

    db.addEvent(taskId, "worker_ended", `Session ${sessionId} ended (exit ${exitCode})`);
    return exitCode;

  } else {
    // Background: redirect all output to log file
    const proc = Bun.spawn(["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], {
      cwd: wtPath,
      env: { ...process.env, GROVE_TASK_ID: taskId, GROVE_WORKTREE_PATH: wtPath },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const pid = proc.pid;
    db.exec("UPDATE sessions SET pid = ? WHERE id = ?", [pid, sessionId]);
    ui.success(`Worker ${taskId} running in background (PID ${pid})`);
    ui.info(`Follow with: tail -f ${logFile}`);

    // Pipe output to log in background (non-blocking)
    (async () => {
      const writer = Bun.file(logFile).writer();
      const stdoutReader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          writer.write(value);
        }
      } catch { /* stream closed */ }

      const stderrReader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          writer.write(value);
        }
      } catch { /* stream closed */ }

      await writer.end();
      const exitCode = await proc.exited;

      // Post-completion for background tasks
      const summary = readSessionSummary(wtPath);
      if (summary) {
        db.taskSet(taskId, "session_summary", summary);
        db.exec("UPDATE sessions SET summary = ? WHERE id = ?", [summary, sessionId]);
      }

      const files = getFilesModified(wtPath);
      if (files) db.taskSet(taskId, "files_modified", files);

      const { costUsd, tokensUsed } = parseCosts(logFile);
      if (costUsd > 0) {
        db.exec("UPDATE tasks SET cost_usd = ? WHERE id = ?", [costUsd, taskId]);
        db.exec("UPDATE sessions SET cost_usd = ? WHERE id = ?", [costUsd, sessionId]);
      }
      if (tokensUsed > 0) {
        db.exec("UPDATE tasks SET tokens_used = ? WHERE id = ?", [tokensUsed, taskId]);
        db.exec("UPDATE sessions SET tokens_used = ? WHERE id = ?", [tokensUsed, sessionId]);
      }

      if (exitCode === 0) {
        db.taskSetStatus(taskId, "done");
        db.sessionEnd(sessionId, "completed");
        notifyUnblocked(taskId);

        // Auto-publish in background
        try {
          await publishTask(taskId, db);
        } catch {
          // Publish failure is non-fatal; task stays at done
        }
      } else {
        db.taskSetStatus(taskId, "failed");
        db.sessionEnd(sessionId, "failed");
      }

      db.addEvent(taskId, "worker_ended", `Session ${sessionId} ended (exit ${exitCode})`);
    })();

    return 0;
  }
}

// ---------------------------------------------------------------------------
// Batch monitor helpers
// ---------------------------------------------------------------------------

export const ANSI = {
  up: (n: number) => `\x1b[${n}A`,
  clearLine: "\x1b[2K",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

export function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "-";
  const dt = new Date(
    startedAt.replace(" ", "T") +
    (startedAt.includes("Z") || startedAt.includes("+") ? "" : "Z")
  );
  if (isNaN(dt.getTime())) return "-";
  const totalSecs = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function batchStatusIcon(status: string): string {
  switch (status) {
    case "running": return `${ANSI.green}⚙${ANSI.reset}`;
    case "done": case "completed": case "review":
      return `${ANSI.green}✓${ANSI.reset}`;
    case "failed": return `${ANSI.red}✗${ANSI.reset}`;
    default: return `${ANSI.dim}·${ANSI.reset}`;
  }
}

export function batchStatusLabel(status: string): string {
  switch (status) {
    case "running": return `${ANSI.green}running${ANSI.reset}`;
    case "done": case "completed": case "review":
      return `${ANSI.green}done${ANSI.reset}`;
    case "failed": return `${ANSI.red}failed${ANSI.reset}`;
    default: return `${ANSI.dim}${status}${ANSI.reset}`;
  }
}

/**
 * Render a compact batch status table.
 * On subsequent calls, moves cursor up to overwrite previous render.
 */
export function renderBatchStatus(taskIds: string[], isFirst: boolean): void {
  const db = getDb();
  const lineCount = taskIds.length + 2; // tasks + blank + summary

  if (!isFirst) {
    process.stdout.write(ANSI.up(lineCount));
  }

  let running = 0, done = 0, failed = 0, totalCost = 0;

  for (const id of taskIds) {
    const task = db.taskGet(id);
    if (!task) {
      process.stdout.write(ANSI.clearLine + `  ? ${id} (not found)\n`);
      continue;
    }

    const icon = batchStatusIcon(task.status);
    const label = batchStatusLabel(task.status);
    const repo = (task.repo ?? "-").padEnd(12);
    const title = task.title.length > 30
      ? task.title.slice(0, 27) + "..."
      : task.title.padEnd(30);
    const elapsed = formatElapsed(task.started_at);
    const cost = task.cost_usd > 0 ? `  $${task.cost_usd.toFixed(2)}` : "";
    const retry = task.retry_count > 0 ? `${ANSI.dim} (retry ${task.retry_count})${ANSI.reset}` : "";

    if (task.status === "running") running++;
    else if (["done", "completed", "review"].includes(task.status)) done++;
    else if (task.status === "failed") failed++;
    totalCost += task.cost_usd || 0;

    process.stdout.write(
      ANSI.clearLine +
      `  ${icon} ${ANSI.bold}${id.padEnd(8)}${ANSI.reset} ${repo} ${title} ${label}  ${ANSI.dim}${elapsed}${ANSI.reset}${cost}${retry}\n`
    );
  }

  const parts = [
    running > 0 ? `${running} running` : "",
    done > 0 ? `${done} done` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");
  const costStr = totalCost > 0 ? ` · $${totalCost.toFixed(2)} total` : "";

  process.stdout.write(ANSI.clearLine + "\n");
  process.stdout.write(ANSI.clearLine + `  ${parts}${costStr}\n`);
}
