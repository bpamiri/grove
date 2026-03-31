// Grove v3 — Gemini CLI adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = "gemini-cli";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "gemini"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["gemini", "-p", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "text") return { kind: "text", content: obj.text?.slice(0, 300) };
    } catch {}
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
