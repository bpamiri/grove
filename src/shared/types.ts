// Grove v3 — All shared types, interfaces, and enums

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TaskStatus {
  Planned = "planned",
  Ready = "ready",
  Running = "running",
  Paused = "paused",
  Done = "done",
  Evaluating = "evaluating",
  Merged = "merged",
  Completed = "completed",
  CiFailed = "ci_failed",
  Failed = "failed",
}

export enum AgentRole {
  Orchestrator = "orchestrator",
  Worker = "worker",
  Evaluator = "evaluator",
}

export enum EventType {
  // Task lifecycle
  TaskCreated = "task_created",
  TaskPlanned = "task_planned",
  TaskStarted = "task_started",
  TaskPaused = "task_paused",
  TaskResumed = "task_resumed",
  TaskDone = "task_done",
  TaskCompleted = "task_completed",
  TaskFailed = "task_failed",
  TaskCancelled = "task_cancelled",
  StatusChange = "status_change",

  // Worker lifecycle
  WorkerSpawned = "worker_spawned",
  WorkerEnded = "worker_ended",
  WorkerStalled = "worker_stalled",
  WorkerCrashed = "worker_crashed",

  // Evaluator
  EvalStarted = "eval_started",
  EvalPassed = "eval_passed",
  EvalFailed = "eval_failed",

  // Quality gates
  GatePassed = "gate_passed",
  GateFailed = "gate_failed",

  // Merge
  PrCreated = "pr_created",
  CiPassed = "ci_passed",
  CiFailed = "ci_failed",
  PrMerged = "pr_merged",

  // Cost
  BudgetWarning = "budget_warning",
  BudgetExceeded = "budget_exceeded",
  CostUpdated = "cost_updated",

  // Orchestrator
  OrchestratorStarted = "orchestrator_started",
  OrchestratorRotated = "orchestrator_rotated",
  OrchestratorCrashed = "orchestrator_crashed",

  // Messages
  MessageSent = "message_sent",
  MessageReceived = "message_received",

  // System
  BrokerStarted = "broker_started",
  BrokerStopped = "broker_stopped",
}

export enum MessageSource {
  User = "user",
  Orchestrator = "orchestrator",
  Worker = "worker",
  System = "system",
}

// ---------------------------------------------------------------------------
// Database row types (match v3 schema.sql)
// ---------------------------------------------------------------------------

export interface Tree {
  id: string;
  name: string;
  path: string;
  github: string | null;
  branch_prefix: string;
  config: string; // JSON
  created_at: string;
}

export interface Task {
  id: string;
  tree_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: string;
  path_name: string;
  priority: number;
  depends_on: string | null;
  branch: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  pr_number: number | null;
  cost_usd: number;
  tokens_used: number;
  gate_results: string | null; // JSON
  session_summary: string | null;
  files_modified: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Session {
  id: string;
  task_id: string | null;
  role: string;
  pid: number | null;
  tmux_pane: string | null;
  cost_usd: number;
  tokens_used: number;
  status: string;
  log_path: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface GroveEvent {
  id: number;
  task_id: string | null;
  session_id: string | null;
  event_type: string;
  summary: string | null;
  detail: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  source: string;
  channel: string;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Config file types (grove.yaml)
// ---------------------------------------------------------------------------

export interface TreeConfig {
  path: string;
  github?: string;
  branch_prefix?: string;
  quality_gates?: QualityGatesConfig;
}

export interface PathConfig {
  description: string;
  steps: string[];
}

export interface BudgetConfig {
  per_task: number;
  per_session: number;
  per_day: number;
  per_week: number;
  auto_approve_under: number;
}

export interface ServerConfig {
  port: number | "auto";
}

export interface TunnelConfig {
  provider: "cloudflare" | "bore" | "ngrok";
  auth: "token" | "none";
  domain?: string;
}

export interface SettingsConfig {
  max_workers: number;
  branch_prefix: string;
  stall_timeout_minutes: number;
  max_retries: number;
  quality_gates?: QualityGatesConfig;
}

export interface GroveConfig {
  workspace: { name: string };
  trees: Record<string, TreeConfig>;
  paths: Record<string, PathConfig>;
  budgets: BudgetConfig;
  server: ServerConfig;
  tunnel: TunnelConfig;
  settings: SettingsConfig;
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
// Broker communication protocol (JSON lines)
// ---------------------------------------------------------------------------

export type BrokerEvent =
  | { type: "status"; task: string; msg: string }
  | { type: "cost"; task: string; usd: number; tokens: number }
  | { type: "done"; task: string; summary: string; pr?: number }
  | { type: "gate"; task: string; gate: string; result: "pass" | "fail"; message?: string }
  | { type: "spawn_worker"; tree: string; task: string; prompt: string; depends_on?: string }
  | { type: "task_update"; task: string; field: string; value: unknown }
  | { type: "user_response"; text: string }
  | { type: "eval_pass"; task: string; feedback?: string }
  | { type: "eval_fail"; task: string; feedback: string }
  | { type: "ci_failed"; task: string; pr: number; logs_url?: string }
  | { type: "merged"; task: string; pr: number }
  | { type: "user_msg"; from: "web" | "cli" | "tmux"; text: string };

// ---------------------------------------------------------------------------
// Event bus event map (typed internal events)
// ---------------------------------------------------------------------------

export interface EventBusMap {
  "broker:started": { port: number; url: string };
  "broker:stopped": undefined;
  "task:created": { task: Task };
  "task:updated": { taskId: string; field: string; value: unknown };
  "task:status": { taskId: string; status: string };
  "worker:spawned": { taskId: string; sessionId: string; pid: number };
  "worker:ended": { taskId: string; sessionId: string; status: string };
  "worker:activity": { taskId: string; msg: string };
  "eval:started": { taskId: string; sessionId: string };
  "eval:passed": { taskId: string; feedback?: string };
  "eval:failed": { taskId: string; feedback: string };
  "gate:result": { taskId: string; gate: string; passed: boolean; message: string };
  "merge:pr_created": { taskId: string; prNumber: number; prUrl: string };
  "merge:ci_passed": { taskId: string; prNumber: number };
  "merge:ci_failed": { taskId: string; prNumber: number };
  "merge:completed": { taskId: string; prNumber: number };
  "cost:updated": { taskId: string; usd: number; tokens: number };
  "cost:budget_warning": { current: number; limit: number; period: string };
  "cost:budget_exceeded": { current: number; limit: number; period: string };
  "monitor:stall": { taskId: string; sessionId: string; inactiveMinutes: number };
  "monitor:crash": { taskId: string; sessionId: string };
  "orchestrator:started": { sessionId: string; pid: number };
  "orchestrator:rotated": { oldSessionId: string; newSessionId: string };
  "message:new": { message: Message };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GROVE_VERSION = "3.0.0-alpha.0";

export const DEFAULT_PATHS: Record<string, PathConfig> = {
  development: {
    description: "Standard dev workflow with QA",
    steps: ["plan", "implement", "evaluate", "merge"],
  },
  research: {
    description: "Research task — produces a report, no code changes",
    steps: ["plan", "research", "report"],
  },
  content: {
    description: "Documentation and content creation",
    steps: ["plan", "implement", "evaluate", "publish"],
  },
};

export const DEFAULT_BUDGETS: BudgetConfig = {
  per_task: 5.0,
  per_session: 10.0,
  per_day: 25.0,
  per_week: 100.0,
  auto_approve_under: 2.0,
};

export const DEFAULT_SETTINGS: SettingsConfig = {
  max_workers: 5,
  branch_prefix: "grove/",
  stall_timeout_minutes: 5,
  max_retries: 2,
};
