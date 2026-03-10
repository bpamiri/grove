// grove resume — Resume a paused task with full context injection
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getEnv } from "../core/db";
import type { Database } from "../core/db";
import * as ui from "../core/ui";
import { createWorktree, worktreeExists } from "../lib/worktree";
import { buildResumePrompt } from "../lib/prompt-builder";
import { deploySandbox, buildResumeTriggerPrompt } from "../lib/sandbox";
import { parseCost, streamMonitor, isAlive } from "../lib/monitor";
import type { Command, Task } from "../types";

export const resumeCommand: Command = {
  name: "resume",
  description: "Resume a paused task with full context from the previous session",

  async run(args: string[]) {
    const db = getDb();
    const { GROVE_LOG_DIR } = getEnv();

    // Parse arguments
    let taskId = "";
    for (const arg of args) {
      if (arg === "-h" || arg === "--help") {
        console.log(resumeCommand.help?.() ?? "");
        return;
      }
      if (!taskId) {
        taskId = arg;
      } else {
        ui.warn(`Unexpected argument: ${arg}`);
      }
    }

    if (!taskId) {
      ui.die("Usage: grove resume TASK_ID");
    }

    // Verify task exists
    if (!db.taskExists(taskId)) {
      ui.die(`Task not found: ${taskId}`);
    }

    // Verify task is paused
    const task = db.taskGet(taskId)!;
    if (task.status !== "paused") {
      ui.die(`Task ${taskId} is '${task.status}', not 'paused'. Only paused tasks can be resumed.`);
    }

    const title = task.title;
    const repo = task.repo;
    const branch = task.branch;
    let worktreePath = task.worktree_path;

    ui.info(`Resuming ${taskId}: ${title}`);

    // Verify worktree still exists; if not, recreate it
    if (worktreePath && !existsSync(worktreePath)) {
      ui.warn(`Worktree missing at ${worktreePath}, recreating...`);
      if (repo && branch) {
        const repoRow = db.repoGet(repo);
        if (repoRow) {
          const repoPath = expandHome(repoRow.local_path);
          if (existsSync(repoPath)) {
            const result = Bun.spawnSync(
              ["git", "worktree", "add", worktreePath, branch],
              { cwd: repoPath },
            );
            if (result.exitCode !== 0) {
              ui.die(`Failed to recreate worktree at ${worktreePath}`);
            }
            ui.success("Worktree recreated");
          } else {
            ui.die("Cannot recreate worktree: repo path not found");
          }
        } else {
          ui.die("Cannot recreate worktree: repo not in database");
        }
      } else {
        ui.die("Cannot recreate worktree: missing repo or branch");
      }
    }

    // If no worktree path at all, create one fresh
    if (!worktreePath && repo) {
      worktreePath = createWorktree(taskId, repo, db);
    }

    // Determine working directory
    let workDir = "";
    if (worktreePath && existsSync(worktreePath)) {
      workDir = worktreePath;
    } else if (repo) {
      const repoRow = db.repoGet(repo);
      if (repoRow) {
        const repoPath = expandHome(repoRow.local_path);
        if (existsSync(repoPath)) {
          workDir = repoPath;
        }
      }
    }

    if (!workDir) {
      ui.die(`No valid working directory for task ${taskId}`);
    }

    // Deploy sandbox (guard hooks + task overlay with resume context)
    deploySandbox(workDir, taskId, db);

    // Build the short trigger prompt (full context is in .claude/CLAUDE.md overlay)
    const resumePrompt = buildResumeTriggerPrompt(taskId);

    // Check that claude is available
    const claudeCheck = Bun.spawnSync(["which", "claude"]);
    if (claudeCheck.exitCode !== 0) {
      ui.die("claude CLI not found. Install Claude Code first.");
    }

    // Create new session
    const sessionId = db.sessionCreate(taskId);

    // Set up log file
    mkdirSync(GROVE_LOG_DIR, { recursive: true });
    const logFile = join(GROVE_LOG_DIR, `${taskId}-session-${sessionId}.log`);
    db.exec(
      "UPDATE sessions SET output_log = ? WHERE id = ?",
      [logFile, sessionId],
    );

    // Set task status to running
    db.taskSetStatus(taskId, "running");
    db.taskSet(taskId, "session_id", String(sessionId));
    db.taskSet(taskId, "started_at", new Date().toISOString().replace("T", " ").slice(0, 19));

    // Log resumed event
    db.addEvent(taskId, "resumed", `Task resumed, session ${sessionId}`);

    ui.success(`Session ${sessionId} started`);
    console.log(`  ${ui.dim("Working dir:")} ${workDir}`);
    console.log(`  ${ui.dim("Log:")}         ${logFile}`);

    // Spawn claude -p in the worktree
    const workerProc = Bun.spawn(
      ["claude", "-p", resumePrompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      {
        cwd: workDir,
        env: { ...process.env, GROVE_TASK_ID: taskId, GROVE_WORKTREE_PATH: workDir },
        stdout: Bun.file(logFile),
        stderr: "inherit",
      },
    );

    const workerPid = workerProc.pid;

    // Store PID in session
    db.exec("UPDATE sessions SET pid = ? WHERE id = ?", [workerPid, sessionId]);

    ui.info(`Worker PID: ${workerPid}`);

    // Monitor the stream
    let costResult = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    try {
      costResult = await streamMonitor(taskId, logFile, db);
    } catch (err: any) {
      ui.warn(`Monitor error: ${err.message}`);
      // Fall back to parsing the log file directly
      costResult = parseCost(logFile);
    }

    // Wait for process to exit
    await workerProc.exited;

    // Also try parsing the final log for more accurate cost
    const finalCost = parseCost(logFile);
    if (finalCost.costUsd > 0) {
      costResult = finalCost;
    }

    const totalTokens = costResult.inputTokens + costResult.outputTokens;

    // Update session with final cost
    db.exec(
      "UPDATE sessions SET cost_usd = ?, tokens_used = ?, ended_at = datetime('now'), status = 'completed' WHERE id = ?",
      [costResult.costUsd, totalTokens, sessionId],
    );

    // Update task cost (accumulate)
    db.exec(
      "UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + ?, tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?",
      [costResult.costUsd, totalTokens, taskId],
    );

    // Try to read session summary from worktree
    const summaryFile = join(workDir, ".grove", "session-summary.md");
    if (existsSync(summaryFile)) {
      try {
        const summaryContent = readFileSync(summaryFile, "utf-8");
        db.taskSet(taskId, "session_summary", summaryContent);
        db.exec("UPDATE sessions SET summary = ? WHERE id = ?", [summaryContent, sessionId]);
      } catch {
        // ignore read errors
      }
    }

    // Capture files modified via git
    const diffResult = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], { cwd: workDir });
    let modifiedFiles = diffResult.stdout.toString().trim();
    if (!modifiedFiles) {
      const diffResult2 = Bun.spawnSync(["git", "diff", "--name-only"], { cwd: workDir });
      modifiedFiles = diffResult2.stdout.toString().trim();
    }
    if (modifiedFiles) {
      db.taskSet(taskId, "files_modified", modifiedFiles);
    }

    // Set task to done (unless it was paused externally during the run)
    const currentStatus = db.taskGetField(taskId, "status") as string;
    if (currentStatus === "running") {
      if (workerProc.exitCode === 0) {
        db.taskSetStatus(taskId, "done");
        db.addEvent(taskId, "completed", `Session ${sessionId} completed (cost: $${costResult.costUsd.toFixed(2)})`);
      } else {
        db.taskSetStatus(taskId, "failed");
        db.addEvent(taskId, "failed", `Session ${sessionId} failed (exit: ${workerProc.exitCode})`);
      }
    }

    ui.success(`Session ${sessionId} finished for ${taskId}`);
    console.log(`  ${ui.dim("Cost:")}    ${ui.dollars(costResult.costUsd)}`);
    console.log(`  ${ui.dim("Tokens:")}  ${totalTokens}`);
  },

  help() {
    return `Usage: grove resume TASK_ID

Resume a paused task with full context from the previous session.

Grove injects the previous session summary, list of modified files,
and next steps into the worker prompt so it can pick up where the
last session left off.

The task must be in "paused" status. A new session is created and
the worker runs in the existing worktree.

Examples:
  grove resume W-005     Resume paused task W-005`;
  },
};

/** Expand ~ to $HOME in a path */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env.HOME || "~", p.slice(2));
  if (p === "~") return process.env.HOME || "~";
  return p;
}
