// Grove v2 — YAML config loading, validation, and dot-notation access
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEnv } from "./db";
import type { GroveConfig, BudgetConfig, RepoConfig } from "../types";

let _config: GroveConfig | null = null;

/** Load and cache the grove.yaml config */
export function loadConfig(): GroveConfig {
  if (_config) return _config;
  const { GROVE_CONFIG } = getEnv();
  const raw = readFileSync(GROVE_CONFIG, "utf-8");
  _config = parseYaml(raw) as GroveConfig;
  return _config;
}

/** Force reload config from disk */
export function reloadConfig(): GroveConfig {
  _config = null;
  return loadConfig();
}

/** Get a config value by dot-notation key (e.g., "budgets.per_week") */
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

/** Set a config value by dot-notation key and write back to disk */
export function configSet(key: string, value: string): void {
  const { GROVE_CONFIG } = getEnv();
  const config = loadConfig();
  const parts = key.split(".");
  let current: any = config;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }

  // Type coerce the value
  const lastKey = parts[parts.length - 1];
  if (value === "true") current[lastKey] = true;
  else if (value === "false") current[lastKey] = false;
  else if (!isNaN(Number(value))) current[lastKey] = Number(value);
  else current[lastKey] = value;

  writeFileSync(GROVE_CONFIG, stringifyYaml(config));
  _config = config;
}

/** Validate the config has required fields */
export function validateConfig(): string[] {
  const config = loadConfig();
  const errors: string[] = [];

  if (!config.workspace?.name) errors.push("Missing workspace.name");
  if (!config.budgets) errors.push("Missing budgets section");

  return errors;
}

/** Get all configured repo names */
export function configRepos(): string[] {
  const config = loadConfig();
  return Object.keys(config.repos || {});
}

/** Get detailed repo config */
export function configRepoDetail(): Record<string, RepoConfig> {
  const config = loadConfig();
  return config.repos || {};
}

/** Get a budget value */
export function budgetGet(field: keyof BudgetConfig): number {
  const config = loadConfig();
  return config.budgets?.[field] ?? 0;
}

/** Get the workspace name */
export function workspaceName(): string {
  const config = loadConfig();
  return config.workspace?.name || "Grove";
}

/** Get settings */
export function settingsGet<K extends keyof GroveConfig["settings"]>(
  key: K
): GroveConfig["settings"][K] {
  const config = loadConfig();
  return config.settings?.[key];
}
