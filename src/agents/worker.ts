// Grove v3 — Worker agent: ephemeral Claude Code sessions for task implementation
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { bus } from "../broker/event-bus";
import { parseCost, isAlive } from "./stream-parser";
import { createCheckpoint, loadCheckpoint } from "./checkpoint";
import { createWorktree, branchName } from "../shared/worktree";
import { deploySandbox, deployReviewSandbox, triggerPrompt, resumeTriggerPrompt, reviewTriggerPrompt, readReviewFeedback } from "../shared/sandbox";
import type { Database } from "../broker/db";
import type { Task, Tree, PipelineStep } from "../shared/types";
import type { AdapterRegistry } from "./adapters/registry";
import { injectSkills, type InjectionResult } from "../skills/injector";

/**
 * Validate that all required skills were injected for a step.
 * Throws if the step requires a result_file and any skills are missing,
 * because the worker cannot produce the expected artifact without the skill.
 */
export function validateSkillInjection(injection: InjectionResult, step: PipelineStep): void {
  if (injection.missing.length > 0 && step.result_file) {
    throw new Error(
      `Required skills missing for step "${step.id}": ${injection.missing.join(", ")}. ` +
      `Step expects result_file "${step.result_file}" which requires these skills. ` +
      `Run "grove up" to bootstrap bundled skills or install manually to ~/.grove/skills/.`
    );
  }
}

export interface WorkerHandle {
  taskId: string;
  sessionId: string;
  pid: number;
  logPath: string;
  worktreePath: string;
  proc: ReturnType<typeof Bun.spawn>;
}

const activeWorkers = new Map<string, WorkerHandle>();
let _adapterRegistry: AdapterRegistry | null = null;

/** Set the adapter registry (called by broker during init) */
export function setAdapterRegistry(registry: AdapterRegistry | null): void { _adapterRegistry = registry; }

/** Spawn a worker for a task. Creates worktree, deploys sandbox, launches claude. */
export function spawnWorker(task: Task, tree: Tree, db: Database, logDir: string, step?: PipelineStep): WorkerHandle {
  if (activeWorkers.has(task.id)) {
    throw new Error(`Worker already active for task ${task.id}`);
  }

  mkdirSync(logDir, { recursive: true });

  const sessionId = `worker-${task.id}-${Date.now()}`;
  const logPath = join(logDir, `${sessionId}.jsonl`);

  // Parse tree config for default_branch
  const treeConfig = tree.config ? JSON.parse(tree.config) : {};

  // Create or reuse worktree (createWorktree returns existing if present)
  const worktreePath = createWorktree(
    task.id,
    tree.path,
    tree.branch_prefix,
    task.title,
    treeConfig.default_branch,
  );

  const stepPrompt = step?.prompt;

  const branch = branchName(task.id, task.title, tree.branch_prefix);

  // Resolve effective skills: per-task overrides take priority over path defaults
  const overrides: Record<string, string[]> | null =
    task.skill_overrides ? JSON.parse(task.skill_overrides) : null;
  const effectiveSkills = (overrides && step?.id && overrides[step.id])
    ? overrides[step.id]
    : (step?.skills ?? []);

  // Inject skills if the step declares any (or task overrides provide them)
  if (effectiveSkills.length > 0) {
    if (overrides && step?.id && overrides[step.id]) {
      db.addEvent(task.id, null, "skills_overridden", `Step "${step.id}" using overridden skills: ${effectiveSkills.join(", ")}`);
    }
    const injection = injectSkills(effectiveSkills, worktreePath);
    if (injection.missing.length > 0) {
      db.addEvent(task.id, null, "skills_missing", `Missing skills: ${injection.missing.join(", ")}`);
    }
    // Fail fast if the step requires a result_file but skills are missing —
    // the worker cannot produce the expected artifact without the skill instructions.
    validateSkillInjection(injection, step);
    if (injection.injected.length > 0) {
      db.addEvent(task.id, null, "skills_injected", `Injected skills: ${injection.injected.join(", ")}`);
    }
  }

  // Check for prior session artifacts to carry forward
  const summaryPath = join(worktreePath, ".grove", "session-summary.md");
  const priorSummary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : task.session_summary;
  const isResumption = !!(priorSummary || task.retry_count > 0);

  // Look up seed spec for this task
  const seed = db.seedGet(task.id);
  const seedSpec = seed?.spec ?? null;

  // Check for review feedback from adversarial review loop
  const reviewFeedback = readReviewFeedback(worktreePath);

  // Load checkpoint if resuming
  const checkpointJson = db.checkpointLoad(task.id);
  let checkpointCtx = undefined;
  if (checkpointJson) {
    try {
      const cp = JSON.parse(checkpointJson);
      checkpointCtx = {
        stepId: cp.stepId,
        stepIndex: cp.stepIndex,
        commitSha: cp.commitSha,
        filesModified: cp.filesModified ?? [],
        sessionSummary: cp.sessionSummary ?? "",
        costSoFar: cp.costSoFar ?? 0,
      };
    } catch {}
  }

  // Detect gated review steps: has result_file + read-only sandbox
  const isReviewStep = !!(step?.result_file && step?.sandbox === "read-only");

  if (isReviewStep) {
    // Read plan content for the reviewer to evaluate
    const planPath = join(worktreePath, ".grove", "plan.md");
    const planContent = existsSync(planPath)
      ? readFileSync(planPath, "utf-8")
      : priorSummary ?? "(No plan document found — review the session summary and code changes instead)";

    // Read prior feedback rounds so reviewer has context
    const priorFeedback: string[] = [];
    if (reviewFeedback) {
      priorFeedback.push(reviewFeedback);
    }

    deployReviewSandbox(worktreePath, {
      taskId: task.id,
      title: task.title,
      description: task.description,
      treePath: tree.path,
      stepPrompt,
      planContent,
      priorFeedback,
    });
  } else {
    // Standard worker sandbox
    deploySandbox(worktreePath, {
      taskId: task.id,
      title: task.title,
      description: task.description,
      treePath: tree.path,
      branch,
      pathName: task.path_name,
      workerInstructions: treeConfig.worker_instructions,
      sessionSummary: priorSummary,
      filesModified: task.files_modified,
      stepPrompt,
      seedSpec,
      reviewFeedback,
      checkpoint: checkpointCtx,
      sandbox: step?.sandbox ?? "read-write",
    });
  }

  // Update task in DB
  db.run("UPDATE tasks SET status = 'active', branch = ?, worktree_path = ?, started_at = datetime('now') WHERE id = ?",
    [branch, worktreePath, task.id]);

  // Use review prompt for gated review steps, else generic prompt
  const prompt = isReviewStep
    ? reviewTriggerPrompt(task.id)
    : isResumption ? resumeTriggerPrompt(task.id) : triggerPrompt(task.id);

  // Resolve adapter: task → tree → global default
  const treeAdapter = treeConfig.adapter;
  const taskAdapter = (task as any).adapter;
  const adapterName = taskAdapter ?? treeAdapter ?? "claude-code";
  const registry = _adapterRegistry;
  const adapter = registry?.get(adapterName) ?? registry?.getDefault();

  if (!adapter) {
    throw new Error(`No adapter available (requested: ${adapterName})`);
  }

  const { proc, pid } = adapter.spawn({
    prompt,
    cwd: worktreePath,
    env: { GROVE_TASK_ID: task.id, GROVE_WORKTREE_PATH: worktreePath },
    logPath,
  });

  // Register session in DB
  db.sessionCreate(sessionId, task.id, "worker", pid, undefined, logPath);
  db.addEvent(task.id, sessionId, "worker_spawned", `Worker spawned (PID: ${pid})`);

  bus.emit("worker:spawned", { taskId: task.id, sessionId, pid });
  bus.emit("agent:spawned", { agentId: sessionId, role: "worker", taskId: task.id, pid, ts: Date.now() });

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
          // stream-json nests content blocks in assistant messages
          if (obj.type === "assistant") {
            for (const block of obj.message?.content ?? []) {
              if (block.type === "tool_use") {
                const tool = block.name ?? "tool";
                const input = block.input ?? {};
                const file = input.file_path ?? input.command ?? input.pattern ?? "";
                const activity = `${tool}: ${String(file).slice(0, 200)}`;
                if (activity !== lastActivity) {
                  lastActivity = activity;
                  bus.emit("worker:activity", { taskId, msg: activity });
                }
                bus.emit("agent:tool_use", { agentId: sessionId, taskId, tool, input: String(file).slice(0, 500), ts: Date.now() });
              } else if (block.type === "thinking" && block.thinking) {
                const snippet = block.thinking.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `thinking: ${snippet}`, kind: "thinking" });
                bus.emit("agent:thinking", { agentId: sessionId, taskId, snippet, ts: Date.now() });
              } else if (block.type === "text" && block.text && block.text.length > 10) {
                const snippet = block.text.slice(0, 300).replace(/\n/g, " ");
                bus.emit("worker:activity", { taskId, msg: `${snippet}`, kind: "text" });
                bus.emit("agent:text", { agentId: sessionId, taskId, content: snippet, ts: Date.now() });
              }
            }
          }
          // Update cost from result events
          if (obj.type === "result" && obj.cost_usd != null) {
            const costUsd = Number(obj.cost_usd);
            const tokens = Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0);
            db.sessionUpdateCost(sessionId, costUsd, tokens);
            bus.emit("agent:cost", { agentId: sessionId, taskId, costUsd, tokens, ts: Date.now() });
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

    // Report completion to step engine
    bus.emit("worker:ended", { taskId, sessionId, status: exitCode === 0 ? "done" : "failed" });
    bus.emit("agent:ended", { agentId: sessionId, role: "worker", taskId, exitCode: exitCode ?? 1, ts: Date.now() });

    // Determine outcome — check result file if configured, else use exit code
    const { onStepComplete, getStepForTask } = await import("../engine/step-engine");
    const currentStep = getStepForTask(taskId);
    let outcome: "success" | "failure" = exitCode === 0 ? "success" : "failure";
    let context: string | undefined;

    if (currentStep?.result_file) {
      const resultPath = join(handle.worktreePath, currentStep.result_file);
      if (existsSync(resultPath)) {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf-8"));
          const key = currentStep.result_key ?? "approved";
          outcome = result[key] ? "success" : "failure";
          context = result.feedback ?? result.reason;

          // Persist PR details from merge result so downstream events carry them
          const prNum = typeof result.pr_number === "number" ? result.pr_number : null;
          const prUrl = typeof result.pr_url === "string" ? result.pr_url : null;
          if (prNum && prUrl) {
            db.run("UPDATE tasks SET pr_number = ?, pr_url = ? WHERE id = ?", [prNum, prUrl, taskId]);
            bus.emit("merge:pr_created", { taskId, prNumber: prNum, prUrl });
          }
        } catch {
          outcome = "failure";
          context = `Failed to parse result file: ${currentStep.result_file}`;
        }
      } else {
        outcome = "failure";
        context = `Result file not found: ${currentStep.result_file}`;
      }
    }

    onStepComplete(taskId, outcome, context);
  } catch (err) {
    db.sessionEnd(sessionId, "crashed");
    db.addEvent(taskId, sessionId, "worker_crashed", `Worker crashed: ${err}`);
    bus.emit("worker:ended", { taskId, sessionId, status: "crashed" });
    bus.emit("agent:crashed", { agentId: sessionId, role: "worker", taskId, error: String(err), ts: Date.now() });
    const { onStepComplete } = await import("../engine/step-engine");
    onStepComplete(taskId, "failure");
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

  // Create checkpoint before killing
  try {
    const task = db.taskGet(taskId);
    if (task && handle.worktreePath) {
      const checkpoint = createCheckpoint(handle.worktreePath, {
        taskId,
        stepId: task.current_step ?? "",
        stepIndex: task.step_index ?? 0,
        sessionSummary: task.session_summary ?? "",
        costSoFar: task.cost_usd,
        tokensSoFar: task.tokens_used,
      });
      db.checkpointSave(taskId, JSON.stringify(checkpoint));
    }
  } catch (err) {
    console.error(`[worker] Checkpoint failed for ${taskId}:`, err);
  }

  try {
    handle.proc.kill();
  } catch {}

  db.sessionEnd(handle.sessionId, "stopped");
  db.run("UPDATE tasks SET paused = 1 WHERE id = ?", [taskId]);
  db.addEvent(taskId, null, "task_paused", "Task paused by user (checkpoint saved)");
  activeWorkers.delete(taskId);

  bus.emit("worker:ended", { taskId, sessionId: handle.sessionId, status: "stopped" });
  bus.emit("agent:ended", { agentId: handle.sessionId, role: "worker", taskId, exitCode: -1, ts: Date.now() });
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
