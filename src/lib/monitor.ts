// Grove v2 — Worker output monitoring
// Functions for parsing claude -p --output-format stream-json output.
import { existsSync, readFileSync, statSync } from "node:fs";

/** Check if a worker process is still running */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parsed cost summary from a stream-json log */
export interface CostSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Parse a completed stream-json log file and extract total cost/tokens.
 * Scans for the last "result" type event.
 */
export function parseCost(logFile: string): CostSummary {
  if (!existsSync(logFile)) {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const content = readFileSync(logFile, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "result") {
        costUsd = Number(obj.cost_usd ?? 0);
        const usage = obj.usage ?? {};
        inputTokens = Number(usage.input_tokens ?? 0);
        outputTokens = Number(usage.output_tokens ?? 0);
      }
    } catch {
      // Not JSON — skip
    }
  }

  return { costUsd, inputTokens, outputTokens };
}

/**
 * Return a one-liner describing the most recent activity from a stream-json log.
 * E.g., "editing router.ts", "running tests", "searching codebase"
 */
export function lastActivity(logFile: string): string {
  if (!existsSync(logFile)) return "no log file";

  const content = readFileSync(logFile, "utf-8");
  let activity = "idle";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const msgType = obj.type ?? "";

    if (msgType === "tool_use") {
      const tool = obj.tool ?? obj.name ?? "";
      const toolInput = obj.input ?? {};
      const toolLower = tool.toLowerCase();

      let filePath = "";
      if (typeof toolInput === "object" && toolInput !== null) {
        filePath = toolInput.file_path ?? toolInput.path ?? toolInput.command ?? "";
      }

      const shortFile = (p: string) =>
        p.includes("/") ? p.split("/").pop()! : p;

      if (toolLower.includes("edit") || toolLower.includes("write")) {
        activity = filePath ? `editing ${shortFile(filePath)}` : "editing file";
      } else if (toolLower.includes("read")) {
        activity = filePath ? `reading ${shortFile(filePath)}` : "reading file";
      } else if (toolLower.includes("bash")) {
        const cmd =
          typeof toolInput === "object" ? toolInput.command ?? "" : "";
        if (/test|pytest|jest/.test(cmd)) {
          activity = "running tests";
        } else if (/git/.test(cmd)) {
          activity = "running git command";
        } else if (/npm|pip|uv/.test(cmd)) {
          activity = "installing dependencies";
        } else if (cmd) {
          activity = `running: ${cmd.slice(0, 40)}`;
        } else {
          activity = "running command";
        }
      } else if (toolLower.includes("grep") || toolLower.includes("glob")) {
        activity = "searching codebase";
      } else {
        activity = `using ${tool}`;
      }
    } else if (msgType === "assistant" || msgType === "text") {
      const content = obj.content ?? obj.text ?? "";
      if (typeof content === "string" && content.length > 10) {
        activity = "thinking";
      }
    } else if (msgType === "result") {
      activity = "completed";
    }
  }

  return activity;
}

// ---------------------------------------------------------------------------
// streamMonitor — tail log file, parse events in real-time, update DB
// ---------------------------------------------------------------------------

/**
 * Tail a stream-json log file in real-time, parse events, periodically update
 * DB with cost/tokens, and wait until the result event arrives or the worker
 * process dies.
 *
 * Returns the final cost/token summary.
 */
export async function streamMonitor(
  taskId: string,
  logFile: string,
  db: import("../core/db").Database,
): Promise<CostSummary> {
  // Wait up to 10 seconds for the log file to appear
  if (!existsSync(logFile)) {
    let waited = 0;
    while (!existsSync(logFile) && waited < 20) {
      await sleep(500);
      waited++;
    }
    if (!existsSync(logFile)) {
      throw new Error(`Log file never appeared: ${logFile}`);
    }
  }

  // Get session ID and worker PID from DB
  const session = db.get<{ id: number; pid: number | null }>(
    "SELECT id, pid FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
    [taskId],
  );
  const sessionId = session?.id ?? 0;
  const workerPid = session?.pid ?? 0;

  // Accumulated state
  let accumulatedCost = 0;
  let accumulatedInput = 0;
  let accumulatedOutput = 0;
  let completed = false;
  let lastDbUpdate = 0;
  const DB_UPDATE_INTERVAL = 5000; // ms

  function updateDb(force = false): void {
    const now = Date.now();
    if (!force && now - lastDbUpdate < DB_UPDATE_INTERVAL) return;
    lastDbUpdate = now;
    try {
      if (sessionId) {
        db.exec(
          "UPDATE sessions SET cost_usd = ?, tokens_used = ? WHERE id = ?",
          [accumulatedCost, accumulatedInput + accumulatedOutput, sessionId],
        );
      }
      db.exec(
        "UPDATE tasks SET updated_at = datetime('now') WHERE id = ?",
        [taskId],
      );
    } catch {
      // Ignore DB errors during monitoring
    }
  }

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }

    const msgType = obj?.type ?? "";

    if (msgType === "result") {
      accumulatedCost = Number(obj.cost_usd) || accumulatedCost;
      const usage = obj.usage ?? {};
      accumulatedInput = Number(usage.input_tokens) || accumulatedInput;
      accumulatedOutput = Number(usage.output_tokens) || accumulatedOutput;
      updateDb(true);
      completed = true;
      return;
    }

    // Periodic cost from usage events
    if (obj?.usage) {
      accumulatedInput = Number(obj.usage.input_tokens) || accumulatedInput;
      accumulatedOutput = Number(obj.usage.output_tokens) || accumulatedOutput;
    }
    if (obj?.cost_usd != null) {
      accumulatedCost = Number(obj.cost_usd) || accumulatedCost;
    }

    updateDb();
  }

  // Tail the file by polling
  let offset = 0;
  let staleCount = 0;

  while (!completed) {
    let content: string;
    try {
      content = readFileSync(logFile, "utf-8");
    } catch {
      await sleep(500);
      staleCount++;
      if (staleCount > 20 && workerPid > 0 && !isAlive(workerPid)) {
        break;
      }
      continue;
    }

    if (content.length > offset) {
      staleCount = 0;
      const newData = content.slice(offset);
      offset = content.length;

      for (const line of newData.split("\n")) {
        processLine(line);
        if (completed) break;
      }
    } else {
      // No new data
      staleCount++;
      if (staleCount > 20) {
        // 10 seconds of no data — check if worker is still alive
        if (workerPid > 0 && !isAlive(workerPid)) {
          // Worker died — process any remaining content
          try {
            const finalContent = readFileSync(logFile, "utf-8");
            if (finalContent.length > offset) {
              for (const line of finalContent.slice(offset).split("\n")) {
                processLine(line);
              }
            }
          } catch {
            // ignore
          }
          break;
        }
        staleCount = 10; // Reset partially to keep checking
      }
      await sleep(500);
    }
  }

  // Final DB update
  updateDb(true);

  return {
    costUsd: accumulatedCost,
    inputTokens: accumulatedInput,
    outputTokens: accumulatedOutput,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Stream formatting (for watch/interactive display)
// ---------------------------------------------------------------------------

/** A parsed stream-json event for display */
export interface StreamEvent {
  type: string;
  text: string;
}

/**
 * Format a single JSON line from stream-json output for human display.
 * Returns null if the line should be skipped.
 */
export function formatStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Non-JSON lines pass through as plain text
  if (!trimmed.startsWith("{")) {
    return { type: "text", text: trimmed };
  }

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { type: "text", text: trimmed };
  }

  const t = obj.type ?? "";

  if (t === "assistant" || t === "text") {
    const text = obj.text ?? obj.content ?? "";
    if (text) return { type: "text", text };
    return null;
  }

  if (t === "tool_use") {
    const name = obj.name ?? obj.tool ?? "tool";
    const inp = obj.input ?? {};
    let cmd = "";
    if (typeof inp === "object" && inp !== null) {
      cmd = (inp.command ?? inp.file_path ?? inp.pattern ?? "").toString();
    } else {
      cmd = String(inp).slice(0, 80);
    }
    return { type: "tool_use", text: `[${name}] ${cmd.slice(0, 120)}` };
  }

  if (t === "tool_result" || t === "result") {
    let content = obj.content ?? obj.output ?? "";
    if (typeof content === "string" && content.length > 200) {
      content = content.slice(0, 200) + "...";
    }
    if (t === "result") {
      // Final result — include cost info if present
      const cost = obj.cost_usd;
      if (cost != null) {
        return {
          type: "result",
          text: `Session complete. Cost: $${Number(cost).toFixed(2)}`,
        };
      }
    }
    if (content) return { type: "tool_result", text: `=> ${content}` };
    return null;
  }

  if (t === "error") {
    const msg = obj.message ?? obj.error ?? JSON.stringify(obj);
    return { type: "error", text: `[error] ${msg}` };
  }

  if (t === "system") {
    const msg = obj.message ?? obj.text ?? JSON.stringify(obj);
    return { type: "system", text: `[system] ${msg}` };
  }

  // Unknown type — show keys
  const keys = Object.keys(obj).join(", ");
  return { type: "info", text: `[${t || "data"}] ${keys}` };
}
