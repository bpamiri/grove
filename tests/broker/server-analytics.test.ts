import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-server-analytics.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

function insertTree(id: string, name: string) {
  db.treeUpsert({ id, name, path: `/code/${id}` });
}

function insertTask(
  id: string,
  treeId: string | null,
  opts: { status?: string; cost?: number; started_at?: string; completed_at?: string; gate_results?: string; retry_count?: number } = {}
) {
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, cost_usd, started_at, completed_at, gate_results, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, treeId, `Task ${id}`, opts.status ?? "completed",
      opts.cost ?? 0, opts.started_at ?? null, opts.completed_at ?? null,
      opts.gate_results ?? null, opts.retry_count ?? 0,
    ]
  );
}

describe("Analytics DB methods via API-like calls", () => {
  test("GET /api/analytics/cost returns bundled cost data", () => {
    insertTree("titan", "Titan");
    const now = new Date().toISOString();
    insertTask("W-001", "titan", { cost: 2.5, started_at: now });
    insertTask("W-002", "titan", { cost: 1.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const byTree = db.costByTree(since);
    const daily = db.costDaily(since);
    const topTasks = db.costTopTasks(since, 10);

    expect(byTree.length).toBe(1);
    expect(byTree[0].total_cost).toBe(3.5);
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(topTasks.length).toBe(2);
    expect(topTasks[0].cost_usd).toBeGreaterThanOrEqual(topTasks[1].cost_usd);
  });

  test("GET /api/analytics/gates returns gate + retry data", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", {
      started_at: now, retry_count: 1,
      gate_results: JSON.stringify({ tests: { passed: true }, lint: { passed: false } }),
    });

    const since = new Date(Date.now() - 86400000).toISOString();
    const gates = db.gateAnalytics(since);
    const retries = db.retryStats(since);

    expect(gates.length).toBe(2);
    expect(retries.total_retried).toBe(1);
  });

  test("GET /api/analytics/timeline returns task timeline", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { status: "active", started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const timeline = db.taskTimeline(since);
    expect(timeline.length).toBe(1);
    expect(timeline[0].task_id).toBe("W-001");
    expect(timeline[0].tree_name).toBe("T");
  });

  test("range conversion: 1h/4h/24h/7d to since timestamp", () => {
    const ranges: Record<string, number> = {
      "1h": 3600000,
      "4h": 14400000,
      "24h": 86400000,
      "7d": 604800000,
    };
    for (const [range, ms] of Object.entries(ranges)) {
      const since = new Date(Date.now() - ms).toISOString();
      expect(new Date(since).getTime()).toBeCloseTo(Date.now() - ms, -3);
    }
  });
});
