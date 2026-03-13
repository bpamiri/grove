// Grove v2 — All shared types, interfaces, and enums

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TaskStatus {
  Ingested = "ingested",
  Planned = "planned",
  Ready = "ready",
  Running = "running",
  Paused = "paused",
  Done = "done",
  Review = "review",
  Completed = "completed",
  Failed = "failed",
}

export enum Strategy {
  Solo = "solo",
  Team = "team",
  Sweep = "sweep",
  Pipeline = "pipeline",
}

export enum EventType {
  Created = "created",
  Planned = "planned",
  Started = "started",
  Paused = "paused",
  Resumed = "resumed",
  WorkerSpawned = "worker_spawned",
  FileModified = "file_modified",
  TestsPassed = "tests_passed",
  PrCreated = "pr_created",
  Completed = "completed",
  Failed = "failed",
  MessageSent = "message_sent",
  MessageReceived = "message_received",
  StatusChange = "status_change",
  Synced = "synced",
  AutoApproved = "auto_approved",
  Cancelled = "cancelled",
  Detached = "detached",
  AutoRetried = "auto_retried",
  RetryExhausted = "retry_exhausted",
  GatePassed = "gate_passed",
  GateFailed = "gate_failed",
  GateRetry = "gate_retry",
}

export enum SourceType {
  Manual = "manual",
  GithubIssue = "github_issue",
  GithubPr = "github_pr",
  Scan = "scan",
}

// ---------------------------------------------------------------------------
// Database row types (match schema.sql exactly)
// ---------------------------------------------------------------------------

export interface Repo {
  name: string;
  org: string;
  github_full: string;
  local_path: string;
  branch_prefix: string | null;
  claude_md_path: string | null;
  last_synced: string | null;
}

export interface Task {
  id: string;
  repo: string | null;
  source_type: string;
  source_ref: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  strategy: string | null;
  strategy_config: string | null;
  estimated_cost: number | null;
  estimated_files: number | null;
  depends_on: string | null;
  retry_count: number;
  max_retries: number | null;
  branch: string | null;
  worktree_path: string | null;
  session_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  session_summary: string | null;
  files_modified: string | null;
  next_steps: string | null;
  cost_usd: number;
  tokens_used: number;
  time_minutes: number;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface Session {
  id: number;
  task_id: string | null;
  repo: string | null;
  worker_type: string | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  cost_usd: number;
  tokens_used: number;
  output_log: string | null;
  summary: string | null;
}

export interface Event {
  id: number;
  task_id: string | null;
  repo: string | null;
  timestamp: string;
  event_type: string;
  summary: string | null;
  detail: string | null;
}

export interface AuditResult {
  id: number;
  task_id: string | null;
  module: string;
  status: string | null;
  completeness: number | null;
  findings: string | null;
  checked_at: string | null;
}

export interface RepoDep {
  upstream: string;
  downstream: string;
  relationship: string | null;
}

export interface ConfigRow {
  key: string;
  value: string | null;
}

// ---------------------------------------------------------------------------
// Config file types (grove.yaml)
// ---------------------------------------------------------------------------

export interface RepoConfig {
  org: string;
  github: string;
  path: string;
  branch_prefix?: string;
  quality_gates?: QualityGatesConfig;
}

export interface BudgetConfig {
  per_task: number;
  per_session: number;
  per_day: number;
  per_week: number;
  auto_approve_under: number;
}

export interface SettingsConfig {
  max_concurrent: number;
  branch_prefix: string;
  auto_sync: boolean;
  stall_timeout_minutes: number;
  max_retries: number;
  quality_gates?: QualityGatesConfig;
}

export interface GroveConfig {
  workspace: { name: string };
  repos: Record<string, RepoConfig>;
  budgets: BudgetConfig;
  settings: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Strategy config (JSON in strategy_config column)
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  teamSize?: number;
  roles?: string[];
  modules?: string[];
}

// ---------------------------------------------------------------------------
// Sandbox types (worker permission & overlay system)
// ---------------------------------------------------------------------------

export interface GuardHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

export interface SandboxConfig {
  hooks: { PreToolUse: GuardHookEntry[] };
}

// ---------------------------------------------------------------------------
// Quality gate types
// ---------------------------------------------------------------------------

export interface GateResult {
  gate: string;
  passed: boolean;
  tier: "hard" | "soft";
  message: string;
}

export interface GateConfig {
  commits: boolean;
  tests: boolean;
  lint: boolean;
  diff_size: boolean;
  min_diff_lines: number;
  max_diff_lines: number;
  test_timeout: number;
  lint_timeout: number;
}

export interface QualityGatesConfig {
  commits?: boolean;
  tests?: boolean;
  lint?: boolean;
  diff_size?: boolean;
  min_diff_lines?: number;
  max_diff_lines?: number;
  test_timeout?: number;
  lint_timeout?: number;
}

// ---------------------------------------------------------------------------
// Command interface
// ---------------------------------------------------------------------------

export interface Command {
  name: string;
  description: string;
  run(args: string[]): Promise<void>;
  help?(): string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GROVE_VERSION = "0.2.0";
