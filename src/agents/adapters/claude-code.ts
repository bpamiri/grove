// Grove v3 — Claude Code adapter
import { readFileSync } from "node:fs";
import type { AgentAdapter, SpawnOpts, ResumeOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  readonly supportsResume = true;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "claude"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const args = ["claude", "-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }
    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }
    for (const dir of opts.additionalDirs ?? []) {
      args.push("--add-dir", dir);
    }
    args.push("--dangerously-skip-permissions");
    args.push(...(opts.additionalArgs ?? []));

    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc, pid: proc.pid };
  }

  resumeSession(opts: ResumeOpts): SpawnResult {
    const args = ["claude", "-p", opts.message, "--output-format", "stream-json", "--verbose", "--resume", opts.sessionId];

    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return null; }

    if (obj.type === "assistant") {
      for (const block of obj.message?.content ?? []) {
        if (block.type === "tool_use") {
          const tool = block.name ?? "tool";
          const input = block.input ?? {};
          const file = (input.file_path ?? input.command ?? input.pattern ?? "").toString().slice(0, 500);
          return { kind: "tool_use", tool, input: file };
        }
        if (block.type === "thinking" && block.thinking) {
          return { kind: "thinking", snippet: block.thinking.slice(0, 300).replace(/\n/g, " ") };
        }
        if (block.type === "text" && block.text && block.text.length > 10) {
          return { kind: "text", content: block.text.slice(0, 300).replace(/\n/g, " ") };
        }
      }
    }

    if (obj.type === "result" && obj.cost_usd != null) {
      return {
        kind: "cost",
        costUsd: Number(obj.cost_usd),
        tokens: Number(obj.usage?.input_tokens ?? 0) + Number(obj.usage?.output_tokens ?? 0),
      };
    }

    return null;
  }

  parseCost(logPath: string): CostResult {
    try {
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "result" && obj.cost_usd != null) {
            return {
              costUsd: Number(obj.cost_usd),
              inputTokens: Number(obj.usage?.input_tokens ?? 0),
              outputTokens: Number(obj.usage?.output_tokens ?? 0),
            };
          }
        } catch {}
      }
    } catch {}
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
