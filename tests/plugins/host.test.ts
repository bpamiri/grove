import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PluginHost } from "../../src/plugins/host";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const TEST_PLUGIN_DIR = join(import.meta.dir, "test-plugins");

beforeEach(() => { mkdirSync(TEST_PLUGIN_DIR, { recursive: true }); });
afterEach(() => { rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true }); });

function createTestPlugin(name: string, manifest: any, moduleCode?: string) {
  const dir = join(TEST_PLUGIN_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  if (moduleCode) writeFileSync(join(dir, "index.js"), moduleCode);
}

describe("PluginHost", () => {
  test("discovers plugins from directory", async () => {
    createTestPlugin("test-gate", { name: "test-gate", version: "1.0.0", description: "Test", hooks: { "gate:custom": { description: "Test gate" } } });
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const plugins = host.list();
    expect(plugins.length).toBe(1);
    expect(plugins[0].name).toBe("test-gate");
  });

  test("ignores directories without plugin.json", async () => {
    mkdirSync(join(TEST_PLUGIN_DIR, "not-a-plugin"), { recursive: true });
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    expect(host.list().length).toBe(0);
  });

  test("runHook returns empty array when no handlers", async () => {
    const host = new PluginHost();
    const results = await host.runHook("gate:custom", {});
    expect(results).toEqual([]);
  });

  test("runHook executes handler and returns results", async () => {
    createTestPlugin("pass-gate", { name: "pass-gate", version: "1.0.0", description: "Pass", hooks: { "gate:custom": { description: "Pass gate" } } },
      `module.exports = { hooks: { "gate:custom": (input) => ({ passed: true, message: "Plugin gate passed" }) } };`);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(1);
    expect(results[0].passed).toBe(true);
  });

  test("runHook catches handler errors", async () => {
    createTestPlugin("bad-gate", { name: "bad-gate", version: "1.0.0", description: "Bad", hooks: { "gate:custom": { description: "Bad" } } },
      `module.exports = { hooks: { "gate:custom": () => { throw new Error("crash"); } } };`);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(0);
  });

  test("enable/disable controls hook execution", async () => {
    createTestPlugin("toggle", { name: "toggle", version: "1.0.0", description: "Toggle", hooks: { "gate:custom": { description: "Toggle" } } },
      `module.exports = { hooks: { "gate:custom": () => ({ passed: true, message: "ran" }) } };`);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    host.disable("toggle");
    expect((await host.runHook("gate:custom", {})).length).toBe(0);
    host.enable("toggle");
    expect((await host.runHook("gate:custom", {})).length).toBe(1);
  });

  test("runHook respects timeout", async () => {
    createTestPlugin("slow", { name: "slow", version: "1.0.0", description: "Slow", hooks: { "gate:custom": { description: "Slow", timeout: 50 } } },
      `module.exports = { hooks: { "gate:custom": () => new Promise(r => setTimeout(r, 5000)) } };`);
    const host = new PluginHost();
    await host.loadAll(TEST_PLUGIN_DIR);
    const results = await host.runHook("gate:custom", {});
    expect(results.length).toBe(0);
  });
});
