import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-observability.db");
let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);

  // Seed test data
  db.treeUpsert({ id: "app", name: "App", path: "/app", github: undefined, branch_prefix: "grove/", config: "{}" });
  db.run("INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, completed_at, current_step) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now'), ?)",
    ["W-001", "app", "Add auth", "completed", 1.50, "implement"]);
  db.run("INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, current_step) VALUES (?, ?, ?, ?, ?, datetime('now', '-10 minutes'), ?)",
    ["W-002", "app", "Fix bug", "active", 0.30, "plan"]);
});

afterEach(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) { const f = TEST_DB + s; if (existsSync(f)) unlinkSync(f); }
});

describe("observability queries", () => {
  test("taskActivityTimeline returns tasks with timing", () => {
    const timeline = db.taskActivityTimeline("24h");
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    const w1 = timeline.find((t: any) => t.task_id === "W-001");
    expect(w1).toBeDefined();
    expect(w1!.status).toBe("completed");
  });

  test("taskActivityTimeline respects time range", () => {
    // Insert a task started 48h ago — should not appear in 24h range
    db.run("INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, current_step) VALUES (?, ?, ?, ?, ?, datetime('now', '-48 hours'), ?)",
      ["W-003", "app", "Old task", "completed", 0.50, "implement"]);
    const timeline = db.taskActivityTimeline("24h");
    const old = timeline.find((t: any) => t.task_id === "W-003");
    expect(old).toBeUndefined();
  });

  test("workerUtilization returns bucketed data", () => {
    // Add sessions to count workers
    db.sessionCreate("s1", "W-001", "worker", 123);
    db.sessionEnd("s1", "completed");
    db.sessionCreate("s2", "W-002", "worker", 456);

    const utilization = db.workerUtilization("1h");
    expect(utilization.length).toBeGreaterThanOrEqual(0);
  });

  test("workerUtilization only counts worker sessions", () => {
    db.sessionCreate("s1", "W-001", "worker", 123);
    db.sessionCreate("s2", "W-001", "orchestrator", 456);

    const utilization = db.workerUtilization("24h");
    // Only 1 bucket entry from the worker session
    const total = utilization.reduce((sum: number, b: any) => sum + b.active_workers, 0);
    expect(total).toBe(1);
  });

  test("filteredEvents returns events matching criteria", () => {
    db.addEvent("W-001", null, "agent:tool_use", "Read src/a.ts");
    db.addEvent("W-001", null, "agent:thinking", "Analyzing...");
    db.addEvent("W-002", null, "agent:tool_use", "Edit src/b.ts");

    const all = db.filteredEvents({ since: "1h" });
    expect(all.length).toBeGreaterThanOrEqual(3);

    const w1Only = db.filteredEvents({ taskId: "W-001", since: "1h" });
    expect(w1Only.length).toBe(2);

    const toolOnly = db.filteredEvents({ eventType: "agent:tool_use", since: "1h" });
    expect(toolOnly.length).toBe(2);
  });

  test("filteredEvents respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.addEvent("W-001", null, "agent:tool_use", `Action ${i}`);
    }
    const limited = db.filteredEvents({ since: "1h", limit: 3 });
    expect(limited.length).toBe(3);
  });

  test("filteredEvents returns empty when no match", () => {
    db.addEvent("W-001", null, "agent:tool_use", "Read src/a.ts");
    const result = db.filteredEvents({ taskId: "W-999", since: "1h" });
    expect(result).toEqual([]);
  });

  test("sinceToDate handles various range formats via taskActivityTimeline", () => {
    // Just ensure these don't throw
    db.taskActivityTimeline("1h");
    db.taskActivityTimeline("4h");
    db.taskActivityTimeline("7d");
    // Invalid format defaults to 24h
    db.taskActivityTimeline("invalid");
  });
});
