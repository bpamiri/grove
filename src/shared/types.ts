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
  Closed = "closed",
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
  adapter: string | null;
  checkpoint: string | null;  // JSON
  labels: string | null;
  pr_url: string | null;
  pr_number: number | null;
  cost_usd: number;
  tokens_used: number;
  skill_overrides: string | null; // JSON: {"step_id": ["skill1", "skill2"]}
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
  worker_instructions?: string; // multiline string injected into worker CLAUDE.md overlay
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
  default_adapter?: string;
  proactive?: boolean;
  rebase_before_eval?: boolean;
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
  version?: number;
  workspace: { name: string };
  trees: Record<string, TreeConfig>;
  paths: Record<string, PathConfig>;
  budgets: BudgetConfig;
  server: ServerConfig;
  tunnel: TunnelConfig;
  settings: SettingsConfig;
  notifications?: NotificationsConfig;
}

export interface PipelineStep {
  id: string;
  type: "worker" | "verdict";
  prompt?: string;
  skills?: string[];
  sandbox?: "read-write" | "read-only";
  result_file?: string;
  result_key?: string;
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
  | { type: "user_msg"; from: "web" | "cli"; text: string };

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

  // SAP agent events
  "agent:spawned": { agentId: string; role: string; taskId: string; pid: number; ts: number };
  "agent:ended": { agentId: string; role: string; taskId: string; exitCode: number; ts: number };
  "agent:crashed": { agentId: string; role: string; taskId: string; error: string; ts: number };
  "agent:tool_use": { agentId: string; taskId: string; tool: string; input: string; ts: number };
  "agent:thinking": { agentId: string; taskId: string; snippet: string; ts: number };
  "agent:text": { agentId: string; taskId: string; content: string; ts: number };
  "agent:cost": { agentId: string; taskId: string; costUsd: number; tokens: number; ts: number };

  // SAP seed events
  "seed:response": { taskId: string; content: string; html?: string; ts: number };
  "seed:chunk": { taskId: string; content: string; ts: number };
  "seed:complete": { taskId: string; summary: string; spec: string; ts: number };
  "seed:idle": { taskId: string; ts: number };

  // Skill management events
  "skill:installed": { name: string };
  "skill:removed": { name: string };

  // Path management events
  "path:created": { name: string };
  "path:updated": { name: string };
  "path:deleted": { name: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GROVE_VERSION = "0.2.13";

export const DEFAULT_PATHS: Record<string, PathConfig> = {
  development: {
    description: "Standard dev workflow with review",
    steps: [
      { id: "implement", type: "worker", prompt: "Implement the task. Commit your changes with conventional commit messages." },
      { id: "review", type: "worker", skills: ["code-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "implement", max_retries: 2 },
      { id: "merge", type: "worker", skills: ["merge-handler"],
        prompt: "Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.",
        result_file: ".grove/merge-result.json", result_key: "merged" },
    ],
  },
  research: {
    description: "Research task — produces a report, no code changes",
    steps: [
      { id: "research", type: "worker", prompt: "Conduct the research. Document findings as you go." },
      { id: "report", type: "worker", skills: ["research-report"], prompt: "Write a clear summary report of your findings in .grove/report.md in the worktree.", on_success: "$done" },
    ],
  },
  adversarial: {
    description: "Adversarial planning with review loop",
    steps: [
      { id: "plan", type: "worker", prompt: "Create a detailed implementation plan for this task. Write it to `.grove/plan.md`." },
      { id: "review-plan", type: "worker", skills: ["adversarial-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "plan", max_retries: 3 },
      { id: "implement", type: "worker", prompt: "Implement the approved plan from `.grove/plan.md`. Commit your changes with conventional commit messages." },
      { id: "review-code", type: "worker", skills: ["code-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "implement", max_retries: 2 },
      { id: "merge", type: "worker", skills: ["merge-handler"],
        prompt: "Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.",
        result_file: ".grove/merge-result.json", result_key: "merged" },
    ],
  },
  "security-audit": {
    description: "Security audit — dependency scan, SAST, secrets detection, and report",
    steps: [
      { id: "scan", type: "worker", skills: ["security-audit"],
        prompt: "Run a comprehensive security scan of this codebase. Check for dependency vulnerabilities, hardcoded secrets, and OWASP top-10 patterns. Write structured findings to `.grove/security-scan.json`.",
        result_file: ".grove/security-scan.json", result_key: "scan_complete" },
      { id: "analyze", type: "worker", skills: ["security-audit"], sandbox: "read-only",
        prompt: "Triage the scan findings in `.grove/security-scan.json`. Cross-reference with known false-positive patterns, classify by severity (critical/high/medium/low/info), and write the triaged results to `.grove/security-analysis.json`.",
        result_file: ".grove/security-analysis.json", result_key: "analysis_complete",
        on_failure: "scan", max_retries: 2 },
      { id: "report", type: "worker", skills: ["security-audit"],
        prompt: "Generate a security audit report at `.grove/security-report.md` from the analysis in `.grove/security-analysis.json`. Include executive summary, critical findings, recommended remediations, and risk ratings." },
      { id: "remediate", type: "worker", skills: ["security-audit"],
        prompt: "Attempt automated fixes for low-risk findings from `.grove/security-analysis.json` — dependency upgrades, pinning versions, removing unused dependencies. Commit each fix separately. Skip anything that requires manual review. Write results to `.grove/security-remediation.json`.",
        result_file: ".grove/security-remediation.json", result_key: "remediation_complete",
        on_failure: "$done" },
    ],
  },
  refactoring: {
    description: "Code refactoring with analysis, safe transformation, and verification",
    steps: [
      { id: "analyze", type: "worker", skills: ["refactoring"],
        prompt: "Analyze the codebase for refactoring targets: code smells, duplicated logic, high cyclomatic complexity, large files. Write a structured analysis to `.grove/refactor-analysis.json` with fields: targets (array of {file, issue, severity, suggestion}), summary, and metrics." },
      { id: "plan", type: "worker", skills: ["refactoring"],
        prompt: "Based on the analysis in `.grove/refactor-analysis.json`, create a refactoring plan. For each change, describe: before/after, risk assessment, and test strategy. Write the plan to `.grove/refactor-plan.md`." },
      { id: "implement", type: "worker", skills: ["refactoring"],
        prompt: "Execute the refactoring plan from `.grove/refactor-plan.md`. Commit atomically per logical change. Preserve all existing behavior — no functional changes." },
      { id: "verify", type: "worker",
        prompt: "Run the full test suite. Compare results against pre-refactoring baseline. Verify: all tests pass, no behavior changes, complexity metrics improved. Write results to `.grove/verify-result.json` with fields: tests_passed (bool), baseline_comparison, metrics_improved (bool).",
        result_file: ".grove/verify-result.json", result_key: "tests_passed", on_failure: "implement", max_retries: 2 },
      { id: "review", type: "worker", skills: ["code-review"], sandbox: "read-only",
        prompt: "Review the refactoring changes. Focus on: accidental behavior changes, missing test coverage for refactored paths, API surface changes, and whether complexity actually decreased. Write verdict to `.grove/review-result.json`.",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "implement", max_retries: 2 },
      { id: "merge", type: "worker", skills: ["merge-handler"],
        prompt: "Push the branch, create a PR, wait for CI, and merge. Follow the merge-handler skill instructions exactly. Write your result to .grove/merge-result.json.",
        result_file: ".grove/merge-result.json", result_key: "merged" },
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
  proactive: true,
  rebase_before_eval: true,
};
