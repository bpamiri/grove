// grove work / grove run — Core dispatch engine
// Selects a task, creates a worktree, spawns a Claude worker session.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, getEnv } from "../core/db";
import { budgetGet, configRepoDetail, settingsGet } from "../core/config";
import * as ui from "../core/ui";
import { pc } from "../core/ui";
import * as prompts from "../core/prompts";
import { createWorktree } from "../lib/worktree";
import { buildPrompt, buildResumePrompt } from "../lib/prompt-builder";
import { deploySandbox, buildTriggerPrompt, buildResumeTriggerPrompt } from "../lib/sandbox";
import type { Command, Task } from "../types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse stream-json log file for cost and token totals */
function parseCosts(logFile: string): { costUsd: number; tokensUsed: number } {
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
function readSessionSummary(worktreePath: string): string | null {
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
function getFilesModified(worktreePath: string): string | null {
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

// ---------------------------------------------------------------------------
// Dispatch a single task
// ---------------------------------------------------------------------------

/**
 * Dispatch a single task: budget check, worktree, prompt, spawn claude.
 * @param taskId - The task to dispatch
 * @param foreground - true = pipe to stdout + log, false = background only
 * @returns exit code (0 = success)
 */
async function dispatchTask(taskId: string, foreground: boolean): Promise<number> {
  const db = getDb();
  const { GROVE_LOG_DIR } = getEnv();

  const task = db.taskGet(taskId);
  if (!task) {
    ui.error(`Task not found: ${taskId}`);
    return 1;
  }

  const { repo, title, status, estimated_cost } = task;

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
      const { planCommand } = await import("./plan");
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
// Command entry point
// ---------------------------------------------------------------------------

export const workCommand: Command = {
  name: "work",
  description: "Dispatch a Claude Code worker session for a task",

  async run(args: string[]) {
    const db = getDb();
    let taskId = "";
    let repoFilter = "";
    let isRun = false;

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--repo") {
        repoFilter = args[++i] || "";
        if (!repoFilter) ui.die("Usage: grove work --repo NAME");
      } else if (arg.startsWith("--repo=")) {
        repoFilter = arg.slice("--repo=".length);
      } else if (arg === "--run") {
        isRun = true;
      } else if (arg === "-h" || arg === "--help") {
        console.log(workCommand.help?.() ?? "");
        return;
      } else if (arg.startsWith("-")) {
        ui.die(`Unknown option: ${arg}`);
      } else {
        taskId = arg;
      }
      i++;
    }

    // --- Mode 1: Specific task ID ---
    if (taskId) {
      if (!db.taskExists(taskId)) {
        ui.die(`Task not found: ${taskId}`);
      }
      await dispatchTask(taskId, true);
      return;
    }

    // --- Mode 2: Next ready task for a repo ---
    if (repoFilter) {
      const next = db.get<{ id: string; title: string }>(
        "SELECT id, title FROM tasks WHERE repo = ? AND status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 1",
        [repoFilter]
      );
      if (!next) {
        ui.info(`No ready tasks for repo: ${repoFilter}`);
        return;
      }
      ui.info(`Next task for ${repoFilter}: ${next.id} — ${next.title}`);
      if (isRun || await prompts.confirm("Start this task?")) {
        await dispatchTask(next.id, true);
      }
      return;
    }

    // --- Mode 3: Batch selection (no args) ---
    const readyTasks = db.all<Task>(
      "SELECT id, repo, title, estimated_cost FROM tasks WHERE status IN ('ready', 'planned') ORDER BY priority ASC, created_at ASC LIMIT 20"
    );

    if (readyTasks.length === 0) {
      ui.info("No tasks ready to work on.");
      console.log(`  Run ${ui.bold("grove add")} to create a task, or ${ui.bold("grove sync")} to pull from GitHub.`);
      return;
    }

    // Non-interactive (run mode): pick the first task
    if (isRun) {
      await dispatchTask(readyTasks[0].id, false);
      return;
    }

    // Interactive: show tasks and let user pick
    ui.header("Ready Tasks");

    const maxConcurrent = settingsGet("max_concurrent") || 4;
    const weekCost = db.costWeek();
    const weekBudget = budgetGet("per_week");

    console.log(`  ${ui.dim("Budget:")} ${ui.dollars(weekCost)} / ${ui.dollars(weekBudget)} this week`);
    console.log(`  ${ui.dim("Max concurrent:")} ${maxConcurrent}`);
    console.log();

    // Display task list
    const taskIds: string[] = [];
    for (let idx = 0; idx < readyTasks.length; idx++) {
      const t = readyTasks[idx];
      const costStr = t.estimated_cost && t.estimated_cost > 0
        ? ` ~${ui.dollars(t.estimated_cost)}`
        : "";
      console.log(`  ${ui.bold(`[${idx + 1}]`)} ${ui.dim(t.id)} ${ui.dim(t.repo || "")}  ${ui.truncate(t.title, 40)}${ui.dim(costStr)}`);
      taskIds.push(t.id);
    }

    console.log();
    console.log("  Enter task number(s) separated by spaces, or \"q\" to quit.");
    console.log("  Example: 1 3 5  (dispatches tasks 1, 3, and 5)");
    console.log();

    // Read selection via readline
    const rl = await import("node:readline");
    const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
    const selection = await new Promise<string>((resolve) => {
      iface.question("  Selection: ", (answer) => {
        iface.close();
        resolve(answer.trim());
      });
    });

    if (!selection || selection === "q" || selection === "Q") {
      return;
    }

    // Parse selections
    const selectedIds: string[] = [];
    for (const sel of selection.split(/\s+/)) {
      const num = parseInt(sel, 10);
      if (isNaN(num)) {
        ui.warn(`Ignoring non-numeric selection: ${sel}`);
        continue;
      }
      if (num < 1 || num > taskIds.length) {
        ui.warn(`Ignoring out-of-range selection: ${sel}`);
        continue;
      }
      selectedIds.push(taskIds[num - 1]);
    }

    if (selectedIds.length === 0) {
      ui.info("No tasks selected.");
      return;
    }

    // Confirm
    ui.info(`Selected ${selectedIds.length} task(s): ${selectedIds.join(" ")}`);
    const confirmed = await prompts.confirm("Dispatch these tasks?");
    if (!confirmed) return;

    console.log();

    // Dispatch
    if (selectedIds.length === 1) {
      await dispatchTask(selectedIds[0], true);
    } else {
      let dispatched = 0;
      for (let idx = 0; idx < selectedIds.length; idx++) {
        if (dispatched >= maxConcurrent) {
          ui.warn(`Reached max concurrent (${maxConcurrent}). Skipping remaining.`);
          break;
        }
        if (idx === 0) {
          ui.info(`Dispatching ${selectedIds[idx]} in foreground...`);
          await dispatchTask(selectedIds[idx], true).catch(() => {});
        } else {
          ui.info(`Dispatching ${selectedIds[idx]} in background...`);
          await dispatchTask(selectedIds[idx], false).catch(() => {});
        }
        dispatched++;
      }
    }
  },

  help() {
    return `Usage: grove work [TASK_ID] [--repo NAME]

Dispatch a Claude Code worker session for a task.

Modes:
  grove work TASK_ID     Start a specific task
  grove work --repo NAME Pick the next ready task for a repo
  grove work             Show ready tasks, choose interactively
  grove run TASK_ID      Non-interactive mode (auto-pick, no prompts)

What happens:
  1. Creates a git worktree for the task
  2. Generates a prompt with task context
  3. Spawns "claude -p" with stream-json output
  4. Captures session summary, cost, and files modified
  5. Updates task status (done/failed)

Options:
  --repo NAME    Filter to tasks for a specific repo
  --run          Non-interactive mode (same as "grove run")

The task must be in "ready" or "planned" status. Budget is checked
against the weekly limit before dispatch. Override with confirmation.

Batch mode: select multiple tasks to dispatch. The first runs in
foreground; the rest run in background up to max_concurrent.`;
  },
};
