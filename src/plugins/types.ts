// Grove v3 — Plugin system type definitions

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks: Record<string, HookDefinition>;
  config?: Record<string, ConfigField>;
}

export interface HookDefinition {
  description: string;
  timeout?: number;
}

export interface ConfigField {
  type: "string" | "number" | "boolean";
  default: unknown;
  description: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
  module: PluginModule | null;
}

export interface PluginModule {
  activate?(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  hooks?: Record<string, HookHandler>;
}

export type HookHandler = (input: any) => any | Promise<any>;

export interface PluginContext {
  config: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  hooks: string[];
}

export interface GateHookInput {
  taskId: string;
  worktreePath: string;
  treeId: string;
  treePath: string;
}

export interface GateHookResult {
  passed: boolean;
  message: string;
}

export interface StepPreHookInput {
  taskId: string;
  stepId: string;
  stepType: string;
  treeId: string;
}

export interface StepPreHookResult {
  proceed: boolean;
  reason?: string;
}

export interface StepPostHookInput {
  taskId: string;
  stepId: string;
  outcome: string;
  context?: string;
}

export interface NotifyHookInput {
  event: string;
  taskId?: string;
  summary: string;
  detail?: string;
}

export interface WorkerPreSpawnInput {
  taskId: string;
  treeId: string;
  prompt: string;
}

export interface WorkerPreSpawnResult {
  prompt?: string;
}
