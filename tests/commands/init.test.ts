// Tests for the init command
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

let tempDir: string;
let originalEnv: { GROVE_HOME?: string; GROVE_ROOT?: string };

const projectRoot = join(import.meta.dir, "../..");

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-init-test-"));
  originalEnv = {
    GROVE_HOME: process.env.GROVE_HOME,
    GROVE_ROOT: process.env.GROVE_ROOT,
  };
  process.env.GROVE_HOME = tempDir;
  process.env.GROVE_ROOT = projectRoot;
});

afterEach(() => {
  if (originalEnv.GROVE_HOME !== undefined) process.env.GROVE_HOME = originalEnv.GROVE_HOME;
  else delete process.env.GROVE_HOME;
  if (originalEnv.GROVE_ROOT !== undefined) process.env.GROVE_ROOT = originalEnv.GROVE_ROOT;
  else delete process.env.GROVE_ROOT;

  rmSync(tempDir, { recursive: true, force: true });
});

describe("initCommand", () => {
  test("creates GROVE_HOME directories", async () => {
    const { initCommand } = await import("../../src/commands/init");
    await initCommand.run([]);

    expect(existsSync(tempDir)).toBe(true);
    expect(existsSync(join(tempDir, "logs"))).toBe(true);
  });

  test("copies grove.yaml from example", async () => {
    const { initCommand } = await import("../../src/commands/init");
    await initCommand.run([]);

    const configPath = join(tempDir, "grove.yaml");
    expect(existsSync(configPath)).toBe(true);
  });

  test("creates DB with tables", async () => {
    const { initCommand } = await import("../../src/commands/init");
    await initCommand.run([]);

    const dbPath = join(tempDir, "grove.db");
    expect(existsSync(dbPath)).toBe(true);

    // Open the DB and verify tables exist
    const db = new Database(dbPath);
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .map((r) => r.name);

    expect(tables).toContain("tasks");
    expect(tables).toContain("sessions");
    expect(tables).toContain("events");
    expect(tables).toContain("config");
    db.close();
  });

  test("sets initialized_at and grove_version config values", async () => {
    const { initCommand } = await import("../../src/commands/init");
    await initCommand.run([]);

    const dbPath = join(tempDir, "grove.db");
    const db = new Database(dbPath);

    const initializedAt = db.configGet("initialized_at");
    expect(initializedAt).not.toBeNull();
    expect(initializedAt!.length).toBeGreaterThan(0);

    const version = db.configGet("grove_version");
    expect(version).not.toBeNull();
    expect(version).toBe("0.2.0");

    db.close();
  });

  test("logs initialization event", async () => {
    const { initCommand } = await import("../../src/commands/init");
    await initCommand.run([]);

    const dbPath = join(tempDir, "grove.db");
    const db = new Database(dbPath);

    const events = db.recentEvents(10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.summary?.includes("initialized"))).toBe(true);

    db.close();
  });
});
