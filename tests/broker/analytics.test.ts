import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.treeUpsert({ id: "api", name: "api", path: "/code/api" });
  db.treeUpsert({ id: "web", name: "web", path: "/code/web" });
});

afterEach(() => {
  db.close();
});

describe("costByTree", () => {
  test("returns cost breakdown per tree", () => {
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-001", "api", "T1", 2.50]);
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-002", "api", "T2", 1.50]);
    db.run("INSERT INTO tasks (id, tree_id, title, cost_usd) VALUES (?, ?, ?, ?)", ["W-003", "web", "T3", 3.00]);
    const result = db.costByTree();
    expect(result.find(r => r.tree_id === "api")!.total_cost).toBe(4.0);
    expect(result.find(r => r.tree_id === "web")!.total_cost).toBe(3.0);
  });
});

describe("gateAnalytics", () => {
  test("counts pass/fail per gate type", () => {
    const gates1 = JSON.stringify([
      { gate: "commits", passed: true, tier: "hard", message: "1 commit" },
      { gate: "tests", passed: false, tier: "hard", message: "fail" },
    ]);
    const gates2 = JSON.stringify([
      { gate: "commits", passed: true, tier: "hard", message: "2 commits" },
      { gate: "tests", passed: true, tier: "hard", message: "pass" },
    ]);
    db.run("INSERT INTO tasks (id, title, gate_results) VALUES (?, ?, ?)", ["W-001", "T1", gates1]);
    db.run("INSERT INTO tasks (id, title, gate_results) VALUES (?, ?, ?)", ["W-002", "T2", gates2]);
    const result = db.gateAnalytics();
    expect(result.find(r => r.gate === "commits")!.passed).toBe(2);
    expect(result.find(r => r.gate === "tests")!.passed).toBe(1);
    expect(result.find(r => r.gate === "tests")!.failed).toBe(1);
  });
});

describe("taskTimeline", () => {
  test("returns tasks within time window", () => {
    db.run("INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, ?, datetime('now'))", ["W-001", "T1", "completed"]);
    const timeline = db.taskTimeline(24);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0].id).toBe("W-001");
  });
});

describe("retryStats", () => {
  test("calculates retry statistics", () => {
    db.run("INSERT INTO tasks (id, title, retry_count) VALUES (?, ?, ?)", ["W-001", "T1", 0]);
    db.run("INSERT INTO tasks (id, title, retry_count) VALUES (?, ?, ?)", ["W-002", "T2", 2]);
    db.run("INSERT INTO tasks (id, title, retry_count) VALUES (?, ?, ?)", ["W-003", "T3", 1]);
    const stats = db.retryStats();
    expect(stats.total_tasks).toBe(3);
    expect(stats.retried_tasks).toBe(2);
    expect(stats.avg_retries).toBeCloseTo(1.5, 1);
  });
});

describe("costTopTasks", () => {
  test("returns tasks ordered by cost", () => {
    db.run("INSERT INTO tasks (id, title, cost_usd) VALUES (?, ?, ?)", ["W-001", "Cheap", 0.50]);
    db.run("INSERT INTO tasks (id, title, cost_usd) VALUES (?, ?, ?)", ["W-002", "Expensive", 5.00]);
    const top = db.costTopTasks(2);
    expect(top[0].id).toBe("W-002");
    expect(top[0].cost_usd).toBe(5.0);
  });
});
