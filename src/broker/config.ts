// Grove v3 — YAML config loading, validation, and dot-notation access
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEnv } from "./db";
import type { GroveConfig, TreeConfig, PathConfig, BudgetConfig, SettingsConfig, ServerConfig, TunnelConfig, NormalizedPathConfig } from "../shared/types";
import { normalizeAllPaths, stripPrompts } from "../engine/normalize";
import { DEFAULT_PATHS, DEFAULT_BUDGETS, DEFAULT_SETTINGS } from "../shared/types";

let _config: GroveConfig | null = null;

const DEFAULT_CONFIG: GroveConfig = {
  workspace: { name: "Grove" },
  trees: {},
  paths: DEFAULT_PATHS,
  budgets: DEFAULT_BUDGETS,
  server: { port: "auto" as const },
  tunnel: { provider: "cloudflare" as const, auth: "token" as const },
  settings: DEFAULT_SETTINGS,
};

export function loadConfig(): GroveConfig {
  if (_config) return _config;
  const { GROVE_CONFIG } = getEnv();
  if (!existsSync(GROVE_CONFIG)) {
    _config = { ...DEFAULT_CONFIG };
    return _config;
  }
  const raw = readFileSync(GROVE_CONFIG, "utf-8");
  const parsed = parseYaml(raw) as Partial<GroveConfig>;
  _config = mergeDefaults(parsed);
  return _config;
}

export function reloadConfig(): GroveConfig {
  _config = null;
  return loadConfig();
}

export function configGet(key: string): any {
  const config = loadConfig();
  const parts = key.split(".");
  let current: any = config;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function configSet(key: string, value: string): void {
  const { GROVE_CONFIG } = getEnv();
  const config = loadConfig();
  const parts = key.split(".");
  let current: any = config;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }

  const lastKey = parts[parts.length - 1];
  if (value === "true") current[lastKey] = true;
  else if (value === "false") current[lastKey] = false;
  else if (!isNaN(Number(value))) current[lastKey] = Number(value);
  else current[lastKey] = value;

  writeFileSync(GROVE_CONFIG, stringifyYaml(config));
  _config = config;
}

export function validateConfig(): string[] {
  const config = loadConfig();
  const errors: string[] = [];

  if (!config.workspace?.name) errors.push("Missing workspace.name");

  for (const [name, tree] of Object.entries(config.trees || {})) {
    if (!tree.path) errors.push(`Tree "${name}" missing path`);
  }

  return errors;
}

export function configTrees(): Record<string, TreeConfig> {
  return loadConfig().trees || {};
}

export function configPaths(): Record<string, PathConfig> {
  return loadConfig().paths || DEFAULT_PATHS;
}

export function configNormalizedPaths(): Record<string, NormalizedPathConfig> {
  return normalizeAllPaths(configPaths());
}

export function configNormalizedPathsForApi(): Record<string, NormalizedPathConfig> {
  return stripPrompts(configNormalizedPaths());
}

export function budgetGet<K extends keyof BudgetConfig>(field: K): number {
  const config = loadConfig();
  return config.budgets?.[field] ?? DEFAULT_BUDGETS[field];
}

export function settingsGet<K extends keyof SettingsConfig>(key: K): SettingsConfig[K] {
  const config = loadConfig();
  return config.settings?.[key] ?? DEFAULT_SETTINGS[key];
}

export function serverConfig(): ServerConfig {
  return loadConfig().server ?? { port: "auto" as const };
}

export function tunnelConfig(): TunnelConfig {
  return loadConfig().tunnel ?? { provider: "cloudflare" as const, auth: "token" as const };
}

export function workspaceName(): string {
  return loadConfig().workspace?.name || "Grove";
}

export function writeDefaultConfig(configPath: string): void {
  writeFileSync(configPath, stringifyYaml(DEFAULT_CONFIG));
}

/** Merge user config with defaults — user values override */
function mergeDefaults(partial: Partial<GroveConfig>): GroveConfig {
  return {
    workspace: partial.workspace ?? DEFAULT_CONFIG.workspace,
    trees: partial.trees ?? {},
    paths: { ...DEFAULT_PATHS, ...partial.paths },
    budgets: { ...DEFAULT_BUDGETS, ...partial.budgets },
    server: { ...DEFAULT_CONFIG.server, ...partial.server },
    tunnel: { ...DEFAULT_CONFIG.tunnel, ...partial.tunnel },
    settings: { ...DEFAULT_SETTINGS, ...partial.settings },
  };
}
