// Grove v3 — Plugin host: discovers, loads, and executes plugin hooks with timeout protection.
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { PluginManifest, LoadedPlugin, PluginModule, PluginInfo, PluginContext } from "./types";

const DEFAULT_TIMEOUT = 60_000;

export class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();

  async loadAll(pluginDir: string): Promise<void> {
    if (!existsSync(pluginDir)) return;
    const entries = readdirSync(pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(pluginDir, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      try {
        await this.load(entry.name, pluginDir);
      } catch (err) {
        console.error(`[plugins] Failed to load "${entry.name}":`, err);
      }
    }
  }

  async load(name: string, pluginDir: string): Promise<void> {
    const dir = join(pluginDir, name);
    const raw = readFileSync(join(dir, "plugin.json"), "utf-8");
    const manifest: PluginManifest = JSON.parse(raw);

    let mod: PluginModule | null = null;
    const indexPath = join(dir, "index.js");
    if (existsSync(indexPath)) {
      try {
        mod = require(indexPath);
        if (mod?.activate) {
          const ctx: PluginContext = {
            config: this.getConfig(manifest.name),
            log: (msg) => console.log(`[plugin:${manifest.name}] ${msg}`),
          };
          await mod.activate(ctx);
        }
      } catch (err) {
        console.error(`[plugins] Error loading module for "${name}":`, err);
      }
    }

    this.plugins.set(manifest.name, { manifest, dir, enabled: true, module: mod });
  }

  async runHook(hookName: string, input: any): Promise<any[]> {
    const results: any[] = [];
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.manifest.hooks[hookName]) continue;
      const handler = plugin.module?.hooks?.[hookName];
      if (!handler) continue;

      const timeout = plugin.manifest.hooks[hookName].timeout ?? DEFAULT_TIMEOUT;
      try {
        const result = await Promise.race([
          Promise.resolve(handler(input)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Hook timed out after ${timeout}ms`)), timeout),
          ),
        ]);
        if (result !== undefined && result !== null) results.push(result);
      } catch (err) {
        console.error(`[plugins] Hook "${hookName}" in "${plugin.manifest.name}" failed:`, err);
      }
    }
    return results;
  }

  list(): PluginInfo[] {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      enabled: p.enabled,
      hooks: Object.keys(p.manifest.hooks),
    }));
  }

  enable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = true;
    return true;
  }

  disable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = false;
    return true;
  }

  getConfig(name: string): Record<string, unknown> {
    const p = this.plugins.get(name);
    if (!p?.manifest.config) return {};
    const config: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(p.manifest.config)) {
      config[key] = field.default;
    }
    return config;
  }

  async shutdown(): Promise<void> {
    for (const [, plugin] of this.plugins) {
      try { await plugin.module?.deactivate?.(); } catch {}
    }
    this.plugins.clear();
  }
}
