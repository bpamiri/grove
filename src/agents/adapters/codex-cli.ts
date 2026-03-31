// Grove v3 — Codex CLI adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class CodexCliAdapter implements AgentAdapter {
  readonly name = "codex-cli";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "codex"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["codex", "-q", "--json", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message") return { kind: "text", content: obj.content?.slice(0, 300) };
      if (obj.type === "tool_call") return { kind: "tool_use", tool: obj.name, input: obj.arguments?.slice(0, 500) };
    } catch {}
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
