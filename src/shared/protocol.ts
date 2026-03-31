// Grove v3 — Structured Agent Protocol (SAP) event types
// All broker-agent and broker-client (WebSocket) communication uses these typed events.

import type { Task } from "./types";

// ---------------------------------------------------------------------------
// SAP Event Union
// ---------------------------------------------------------------------------

export type SapEvent =
  // Agent lifecycle
  | SapAgentSpawned
  | SapAgentEnded
  | SapAgentCrashed

  // Fine-grained activity (from stream-json parsing)
  | SapAgentToolUse
  | SapAgentThinking
  | SapAgentText
  | SapAgentCost

  // Seed-specific
  | SapSeedResponse
  | SapSeedComplete
  | SapSeedIdle

  // Task lifecycle
  | SapTaskStatus
  | SapTaskCreated

  // Gate results
  | SapGateResult

  // Merge lifecycle
  | SapMergePrCreated
  | SapMergeCompleted

  // Cost/budget
  | SapCostWarning
  | SapCostExceeded;

// ---------------------------------------------------------------------------
// Individual event types
// ---------------------------------------------------------------------------

interface SapBase { ts: number }

export interface SapAgentSpawned extends SapBase { type: "agent:spawned"; agentId: string; role: string; taskId: string; pid: number }
export interface SapAgentEnded extends SapBase { type: "agent:ended"; agentId: string; role: string; taskId: string; exitCode: number }
export interface SapAgentCrashed extends SapBase { type: "agent:crashed"; agentId: string; role: string; taskId: string; error: string }

export interface SapAgentToolUse extends SapBase { type: "agent:tool_use"; agentId: string; taskId: string; tool: string; input: string }
export interface SapAgentThinking extends SapBase { type: "agent:thinking"; agentId: string; taskId: string; snippet: string }
export interface SapAgentText extends SapBase { type: "agent:text"; agentId: string; taskId: string; content: string }
export interface SapAgentCost extends SapBase { type: "agent:cost"; agentId: string; taskId: string; costUsd: number; tokens: number }

export interface SapSeedResponse extends SapBase { type: "seed:response"; taskId: string; content: string; html?: string }
export interface SapSeedComplete extends SapBase { type: "seed:complete"; taskId: string; summary: string; spec: string }
export interface SapSeedIdle extends SapBase { type: "seed:idle"; taskId: string }

export interface SapTaskStatus extends SapBase { type: "task:status"; taskId: string; status: string }
export interface SapTaskCreated extends SapBase { type: "task:created"; task: Task }

export interface SapGateResult extends SapBase { type: "gate:result"; taskId: string; gate: string; passed: boolean; message: string }

export interface SapMergePrCreated extends SapBase { type: "merge:pr_created"; taskId: string; prNumber: number; prUrl: string }
export interface SapMergeCompleted extends SapBase { type: "merge:completed"; taskId: string; prNumber: number }

export interface SapCostWarning extends SapBase { type: "cost:warning"; current: number; limit: number; period: string }
export interface SapCostExceeded extends SapBase { type: "cost:exceeded"; current: number; limit: number; period: string }

// ---------------------------------------------------------------------------
// Valid event type strings
// ---------------------------------------------------------------------------

const SAP_EVENT_TYPES = new Set([
  "agent:spawned", "agent:ended", "agent:crashed",
  "agent:tool_use", "agent:thinking", "agent:text", "agent:cost",
  "seed:response", "seed:complete", "seed:idle",
  "task:status", "task:created",
  "gate:result",
  "merge:pr_created", "merge:completed",
  "cost:warning", "cost:exceeded",
]);

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** Check if an object is a valid SAP event (has a known type + ts) */
export function isSapEvent(obj: unknown): obj is SapEvent {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o.type === "string" && SAP_EVENT_TYPES.has(o.type) && typeof o.ts === "number";
}

/** Parse a JSON string into a SapEvent, or return null */
export function parseSapEvent(json: string): SapEvent | null {
  try {
    const obj = JSON.parse(json);
    return isSapEvent(obj) ? obj : null;
  } catch {
    return null;
  }
}
