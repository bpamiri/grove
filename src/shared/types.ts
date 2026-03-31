// Grove v3 — All shared types, interfaces, and enums

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TaskStatus {
  Draft = "draft",
  Queued = "queued",
  Active = "active",
  Completed = "completed",
  Failed = "failed",
}

export enum AgentRole {
  Orchestrator = "orchestrator",
  Worker = "worker",
  Evaluator = "evaluator",
  Reviewer = "reviewer",
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

  // Reviewer
  ReviewStarted = "review_started",
  ReviewApproved = "review_approved",
  ReviewRejected = "review_rejected",

  // Quality gates
  GatePassed = "gate_passed",
  GateFailed = "gate_failed",

  // Merge & Issues
  PrCreated = "pr_created",
  CiPassed = "ci_passed",
  CiFailed = "ci_failed",
  PrMerged = "pr_merged",
  IssueCreated = "issue_created",
  IssueCreateFailed = "issue_create_failed",

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
  current_step: string | null;
  step_index: number;
  paused: number;
  path_name: string;
  priority: number;
  depends_on: string | null;
  branch: string | null;
  worktree_path: string | null;
  github_issue: number | null;
  source_pr: number | null;
  labels: string | null;
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
  default_branch?: string; // e.g. "develop", "main" — branch to fork worktrees from
  default_path?: string;   // e.g. "adversarial", "content" — default path for new tasks in this tree
  quality_gates?: QualityGatesConfig;
}

export interface PathConfig {
  description: string;
  steps: Array<string | Record<string, any>>;
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
  domain?: string;      // e.g. "grove.cloud" — register with Worker proxy for stable vanity URL
  subdomain?: string;   // auto-generated on first start, persisted across restarts
  secret?: string;      // auto-generated, proves subdomain ownership with Worker
}

export interface SettingsConfig {
  max_workers: number;
  branch_prefix: string;
  stall_timeout_minutes: number;
  max_retries: number;
  quality_gates?: QualityGatesConfig;
}

export type NotificationEventName =
  | "task_completed"
  | "task_failed"
  | "gate_failed"
  | "pr_merged"
  | "ci_failed"
  | "budget_warning"
  | "budget_exceeded"
  | "orchestrator_crashed";

export interface SlackChannelConfig {
  webhook_url: string;
  events?: NotificationEventName[];
}

export interface SystemChannelConfig {
  enabled: boolean;
  quiet_hours?: { start: string; end: string }; // "HH:MM" format, e.g. "22:00"
  events?: NotificationEventName[];
}

export interface WebhookChannelConfig {
  url: string;
  secret: string;
  events?: NotificationEventName[];
}

export interface NotificationsConfig {
  slack?: SlackChannelConfig;
  system?: SystemChannelConfig;
  webhook?: WebhookChannelConfig;
}

export interface GroveConfig {
  workspace: { name: string };
  trees: Record<string, TreeConfig>;
  paths: Record<string, PathConfig>;
  budgets: BudgetConfig;
  server: ServerConfig;
  tunnel: TunnelConfig;
  settings: SettingsConfig;
  notifications?: NotificationsConfig;
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
  test_command?: string;  // e.g. "npm test", "pytest", "wheels test run"
  lint_command?: string;  // e.g. "npx eslint .", "ruff check ."
  base_ref?: string;      // git ref to diff against (default: auto-detect origin/main or main)
}

export interface PipelineStep {
  id: string;
  type: "worker" | "gate" | "merge" | "review" | "verdict";
  prompt?: string;
  on_success: string;
  on_failure: string;
  max_retries?: number;
  label?: string;
}

export interface NormalizedPathConfig {
  description: string;
  steps: PipelineStep[];
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
  "review:started": { taskId: string; sessionId: string };
  "review:approved": { taskId: string; feedback?: string };
  "review:rejected": { taskId: string; feedback: string };
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

export const GROVE_VERSION = "0.1.16";

export const DEFAULT_PATHS: Record<string, PathConfig> = {
  development: {
    description: "Standard dev workflow with QA",
    steps: [
      { id: "plan", type: "worker", prompt: "Analyze the task requirements. Identify which files need changes and outline your implementation approach." },
      { id: "implement", type: "worker", prompt: "Implement the task. Commit your changes with conventional commit messages." },
      { id: "evaluate", type: "gate", on_failure: "implement" },
      { id: "merge", type: "merge" },
    ],
  },
  research: {
    description: "Research task — produces a report, no code changes",
    steps: [
      { id: "plan", type: "worker", prompt: "Analyze what needs to be researched. Identify sources and outline your approach." },
      { id: "research", type: "worker", prompt: "Conduct the research. Document findings as you go." },
      { id: "report", type: "worker", prompt: "Write a clear summary report of your findings in .grove/report.md in the worktree.", on_success: "$done" },
    ],
  },
  content: {
    description: "Documentation and content creation",
    steps: [
      { id: "plan", type: "worker", prompt: "Outline the content structure, audience, and key points." },
      { id: "implement", type: "worker", prompt: "Write the content following the plan." },
      { id: "evaluate", type: "gate", on_failure: "implement" },
      { id: "publish", type: "merge" },
    ],
  },
  adversarial: {
    description: "Adversarial planning with review loop",
    steps: [
      { id: "plan", type: "worker", prompt: "Create a detailed implementation plan for this task. Write it to `.grove/plan.md` in the worktree. Include: approach, files to modify, test strategy, edge cases, and backwards compatibility considerations." },
      { id: "review", type: "review", prompt: "You are an adversarial reviewer for an open-source framework. Critique this plan for: correctness, backwards compatibility, missing edge cases, test coverage gaps, API design quality. Be rigorous — reject plans that are vague, incomplete, or risk breaking existing behavior.", on_failure: "plan", max_retries: 3 },
      { id: "implement", type: "worker", prompt: "Implement the approved plan from `.grove/plan.md`. Follow it closely. Commit your changes with conventional commit messages." },
      { id: "evaluate", type: "gate", on_failure: "implement" },
      { id: "merge", type: "merge" },
    ],
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
