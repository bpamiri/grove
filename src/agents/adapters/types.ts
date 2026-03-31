// Grove v3 — Agent adapter interface
// Abstracts CLI-specific spawn/parse logic so Grove can use multiple AI agent CLIs.

export interface AgentAdapter {
  readonly name: string;
  readonly supportsResume: boolean;

  /** Check if the CLI binary is available on PATH */
  isAvailable(): boolean;

  /** Spawn a one-shot agent process */
  spawn(opts: SpawnOpts): SpawnResult;

  /** Resume an existing session (only if supportsResume is true) */
  resumeSession?(opts: ResumeOpts): SpawnResult;

  /** Parse a stdout line into a normalized activity event, or null */
  parseOutputLine(line: string): ParsedActivity | null;

  /** Extract final cost from a completed log file */
  parseCost(logPath: string): CostResult;
}

export interface SpawnOpts {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
  systemPrompt?: string;
  sessionId?: string;
  additionalArgs?: string[];
  additionalDirs?: string[];
}

export interface ResumeOpts {
  message: string;
  sessionId: string;
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
}

export interface SpawnResult {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
}

export interface ParsedActivity {
  kind: "tool_use" | "thinking" | "text" | "cost" | "result";
  tool?: string;
  input?: string;
  snippet?: string;
  content?: string;
  costUsd?: number;
  tokens?: number;
  exitCode?: number;
}

export interface CostResult {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
