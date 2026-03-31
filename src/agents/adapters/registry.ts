// Grove v3 — Agent adapter registry
import type { AgentAdapter } from "./types";

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private defaultName: string | null = null;

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
    if (!this.defaultName) this.defaultName = adapter.name;
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getDefault(): AgentAdapter {
    const adapter = this.defaultName ? this.adapters.get(this.defaultName) : undefined;
    if (!adapter) throw new Error("No adapters registered");
    return adapter;
  }

  setDefault(name: string): void {
    if (!this.adapters.has(name)) throw new Error(`Adapter "${name}" not registered`);
    this.defaultName = name;
  }

  listAll(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Auto-detect which adapters have their CLI available on PATH */
  detectAvailable(): string[] {
    return this.listAll().filter(a => a.isAvailable()).map(a => a.name);
  }
}
