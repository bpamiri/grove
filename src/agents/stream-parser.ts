// Grove v3 — Unified stream-json parser for Claude Code output
// Parses both real-time (line-by-line) and completed log files.
import { existsSync, readFileSync } from "node:fs";
import type { BrokerEvent } from "../shared/types";

/** Check if a process is still running */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cost/token summary from a completed session */
export interface CostSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Parse a completed stream-json log file for total cost/tokens */
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

/** Extract current activity description from a stream-json log */
export function lastActivity(logFile: string): string {
  if (!existsSync(logFile)) return "no log";

  const content = readFileSync(logFile, "utf-8");
  let activity = "idle";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const msgType = obj.type ?? "";

    if (msgType === "tool_use") {
      const tool = obj.tool ?? obj.name ?? "";
      const toolInput = obj.input ?? {};
      const toolLower = tool.toLowerCase();

      let filePath = "";
      if (typeof toolInput === "object" && toolInput !== null) {
        filePath = toolInput.file_path ?? toolInput.path ?? toolInput.command ?? "";
      }

      const shortFile = (p: string) => p.includes("/") ? p.split("/").pop()! : p;

      if (toolLower.includes("edit") || toolLower.includes("write")) {
        activity = filePath ? `editing ${shortFile(filePath)}` : "editing file";
      } else if (toolLower.includes("read")) {
        activity = filePath ? `reading ${shortFile(filePath)}` : "reading file";
      } else if (toolLower.includes("bash")) {
        const cmd = typeof toolInput === "object" ? toolInput.command ?? "" : "";
        if (/test|pytest|jest/.test(cmd)) activity = "running tests";
        else if (/git/.test(cmd)) activity = "running git command";
        else if (/npm|pip|uv|bun/.test(cmd)) activity = "installing dependencies";
        else if (cmd) activity = `running: ${cmd.slice(0, 40)}`;
        else activity = "running command";
      } else if (toolLower.includes("grep") || toolLower.includes("glob")) {
        activity = "searching codebase";
      } else {
        activity = `using ${tool}`;
      }
    } else if (msgType === "assistant" || msgType === "text") {
      const content = obj.content ?? obj.text ?? "";
      if (typeof content === "string" && content.length > 10) activity = "thinking";
    } else if (msgType === "result") {
      activity = "completed";
    }
  }

  return activity;
}

/** A parsed stream event for display */
export interface StreamEvent {
  type: string;
  text: string;
}

/** Format a single JSON line from stream-json output for human display */
export function formatStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("{")) return { type: "text", text: trimmed };

  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return { type: "text", text: trimmed }; }

  const t = obj.type ?? "";

  if (t === "assistant" || t === "text") {
    const text = obj.text ?? obj.content ?? "";
    if (text) return { type: "text", text };
    return null;
  }

  if (t === "tool_use") {
    const name = obj.name ?? obj.tool ?? "tool";
    const inp = obj.input ?? {};
    let detail = "";
    if (typeof inp === "object" && inp !== null) {
      detail = (inp.command ?? inp.file_path ?? inp.pattern ?? "").toString();
    }
    return { type: "tool_use", text: `[${name}] ${detail.slice(0, 120)}` };
  }

  if (t === "result") {
    const cost = obj.cost_usd;
    if (cost != null) return { type: "result", text: `Session complete. Cost: $${Number(cost).toFixed(2)}` };
    return { type: "result", text: "Session complete" };
  }

  if (t === "error") {
    const msg = obj.message ?? obj.error ?? JSON.stringify(obj);
    return { type: "error", text: `[error] ${msg}` };
  }

  return null;
}

/** Try to parse a line as a Grove broker event (emitted by orchestrator) */
export function parseBrokerEvent(line: string): BrokerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.type && typeof obj.type === "string") {
      return obj as BrokerEvent;
    }
  } catch {
    // Not JSON or not a broker event
  }
  return null;
}

/**
 * Tail a log file, calling onLine for each new line.
 * Returns a cleanup function that stops tailing.
 */
export function tailLog(
  logFile: string,
  onLine: (line: string) => void,
  intervalMs: number = 500,
): () => void {
  let offset = 0;
  let stopped = false;

  const poll = async () => {
    while (!stopped) {
      try {
        if (existsSync(logFile)) {
          const content = readFileSync(logFile, "utf-8");
          if (content.length > offset) {
            const newData = content.slice(offset);
            offset = content.length;
            for (const line of newData.split("\n")) {
              if (line.trim()) onLine(line);
            }
          }
        }
      } catch {
        // File read error — retry next interval
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  };

  poll();

  return () => { stopped = true; };
}
