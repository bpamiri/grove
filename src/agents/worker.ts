// Grove v3 — Worker agent: ephemeral Claude Code sessions for task implementation
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { parseCost, isAlive } from "./stream-parser";
import { createWorktree, branchName } from "../shared/worktree";
import { deploySandbox, triggerPrompt, resumeTriggerPrompt } from "../shared/sandbox";
import type { Database } from "../broker/db";
import type { Task, Tree } from "../shared/types";

export interface WorkerHandle {
  taskId: string;
  sessionId: string;
  pid: number;
  logPath: string;
  worktreePath: string;
  proc: ReturnType<typeof Bun.spawn>;
}

const activeWorkers = new Map<string, WorkerHandle>();

/** Spawn a worker for a task. Creates worktree, deploys sandbox, launches claude. */
export function spawnWorker(task: Task, tree: Tree, db: Database, logDir: string): WorkerHandle {
  if (activeWorkers.has(task.id)) {
    throw new Error(`Worker already active for task ${task.id}`);
  }

  mkdirSync(logDir, { recursive: true });

  const sessionId = `worker-${task.id}-${Date.now()}`;
  const logPath = join(logDir, `${sessionId}.jsonl`);

  // Create or reuse worktree (createWorktree returns existing if present)
  const worktreePath = createWorktree(
    task.id,
    tree.path,
    tree.branch_prefix,
    task.title,
  );

  const branch = branchName(task.id, task.title, tree.branch_prefix);

  // Check for prior session artifacts to carry forward
  const summaryPath = join(worktreePath, ".grove", "session-summary.md");
  const priorSummary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : task.session_summary;
  const isResumption = !!(priorSummary || task.retry_count > 0);

  // Deploy sandbox (guard hooks + CLAUDE.md overlay with prior context)
  deploySandbox(worktreePath, {
    taskId: task.id,
    title: task.title,
    description: task.description,
    treePath: tree.path,
    branch,
    pathName: task.path_name,
    sessionSummary: priorSummary,
    filesModified: task.files_modified,
  });

  // Update task in DB
  db.run("UPDATE tasks SET status = 'running', branch = ?, worktree_path = ?, started_at = datetime('now') WHERE id = ?",
    [branch, worktreePath, task.id]);

  // Use resume prompt if continuing from a prior session
  const prompt = isResumption ? resumeTriggerPrompt(task.id) : triggerPrompt(task.id);

  // Spawn claude in the worktree
  const logFile = Bun.file(logPath);
  const logWriter = logFile.writer();

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

  const pid = proc.pid;

  // Register session in DB
  db.sessionCreate(sessionId, task.id, "worker", pid, undefined, logPath);
  db.addEvent(task.id, sessionId, "worker_spawned", `Worker spawned (PID: ${pid})`);

  bus.emit("worker:spawned", { taskId: task.id, sessionId, pid });

  // Pipe stdout to log file and parse events
  const handle: WorkerHandle = { taskId: task.id, sessionId, pid, logPath, worktreePath, proc };
  activeWorkers.set(task.id, handle);

  // Monitor the worker asynchronously
  monitorWorker(handle, db);

  return handle;
}

/** Monitor a worker's stdout, update DB, and handle completion */
async function monitorWorker(handle: WorkerHandle, db: Database): Promise<void> {
  const { taskId, sessionId, logPath, proc } = handle;

  try {
    // Read stdout and write to log
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("Worker stdout not available");
    }
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const logFile = Bun.file(logPath);
    const writer = logFile.writer();

    let lastActivity = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value);
      writer.write(text);
      writer.flush();

      // Parse lines for activity updates
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          // stream-json nests tool_use in assistant message content blocks
          if (obj.type === "assistant") {
            for (const block of obj.message?.content ?? []) {
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                const activity = `${tool}: ${String(file).slice(0, 60)}`;
                if (activity !== lastActivity) {
                  lastActivity = activity;
                  bus.emit("worker:activity", { taskId, msg: activity });
                }
              }
            }
          }
          // Update cost from result events
          if (obj.type === "result" && obj.cost_usd != null) {
            db.sessionUpdateCost(sessionId, Number(obj.cost_usd), Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0));
          }
        } catch {
          // Not JSON
        }
      }
    }

    writer.end();

    // Wait for process to exit
    const exitCode = await proc.exited;

    // Parse final cost
    const cost = parseCost(logPath);

    // Update DB
    db.sessionUpdateCost(sessionId, cost.costUsd, cost.inputTokens + cost.outputTokens);
    db.sessionEnd(sessionId, exitCode === 0 ? "completed" : "failed");

    // Update task cost
    db.run("UPDATE tasks SET cost_usd = cost_usd + ?, tokens_used = tokens_used + ? WHERE id = ?",
      [cost.costUsd, cost.inputTokens + cost.outputTokens, taskId]);

    // Read session summary if worker wrote one
    const summaryPath = join(handle.worktreePath, ".grove", "session-summary.md");
    if (existsSync(summaryPath)) {
      const summary = readFileSync(summaryPath, "utf-8");
      db.run("UPDATE tasks SET session_summary = ? WHERE id = ?", [summary, taskId]);
    }

    // Get files modified via git diff
    const diffResult = Bun.spawnSync(["git", "-C", handle.worktreePath, "diff", "--name-only", "main...HEAD"]);
    if (diffResult.exitCode === 0) {
      const files = diffResult.stdout.toString().trim();
      if (files) {
        db.run("UPDATE tasks SET files_modified = ? WHERE id = ?", [files, taskId]);
      }
    }

    // Update task status
    if (exitCode === 0) {
      db.taskSetStatus(taskId, "done");
      bus.emit("worker:ended", { taskId, sessionId, status: "done" });
    } else {
      db.taskSetStatus(taskId, "failed");
      bus.emit("worker:ended", { taskId, sessionId, status: "failed" });
    }
  } catch (err) {
    db.sessionEnd(sessionId, "crashed");
    db.taskSetStatus(taskId, "failed");
    db.addEvent(taskId, sessionId, "worker_crashed", `Worker crashed: ${err}`);
    bus.emit("worker:ended", { taskId, sessionId, status: "crashed" });
  } finally {
    activeWorkers.delete(taskId);
  }
}

/** Get all active workers */
export function getActiveWorkers(): Map<string, WorkerHandle> {
  return activeWorkers;
}

/** Check if a worker is active for a task */
export function isWorkerActive(taskId: string): boolean {
  const handle = activeWorkers.get(taskId);
  if (!handle) return false;
  return isAlive(handle.pid);
}

/** Stop a worker */
export function stopWorker(taskId: string, db: Database): boolean {
  const handle = activeWorkers.get(taskId);
  if (!handle) return false;

  try {
    handle.proc.kill();
  } catch {}

  db.sessionEnd(handle.sessionId, "stopped");
  db.taskSetStatus(taskId, "paused");
  activeWorkers.delete(taskId);

  bus.emit("worker:ended", { taskId, sessionId: handle.sessionId, status: "stopped" });
  return true;
}

/** Get count of active workers */
export function activeWorkerCount(): number {
  // Clean up dead workers
  for (const [taskId, handle] of activeWorkers) {
    if (!isAlive(handle.pid)) {
      activeWorkers.delete(taskId);
    }
  }
  return activeWorkers.size;
}
