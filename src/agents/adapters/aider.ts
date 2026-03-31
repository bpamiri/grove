// Grove v3 — Aider adapter (stub)
import type { AgentAdapter, SpawnOpts, SpawnResult, ParsedActivity, CostResult } from "./types";

export class AiderAdapter implements AgentAdapter {
  readonly name = "aider";
  readonly supportsResume = false;

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", "aider"]);
    return result.exitCode === 0;
  }

  spawn(opts: SpawnOpts): SpawnResult {
    const proc = Bun.spawn(["aider", "--yes-always", "--no-git", "--message", opts.prompt], {
      cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    return { proc, pid: proc.pid };
  }

  parseOutputLine(line: string): ParsedActivity | null {
    if (line.includes("Applied edit to")) return { kind: "tool_use", tool: "Edit", input: line.split("Applied edit to ")[1] };
    return null;
  }

  parseCost(_logPath: string): CostResult {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
