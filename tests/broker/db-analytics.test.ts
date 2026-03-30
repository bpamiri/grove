import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-analytics.db");

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

// Helper: insert a tree
function insertTree(id: string, name: string) {
  db.treeUpsert({ id, name, path: `/code/${id}` });
}

// Helper: insert a task with cost
function insertTask(
  id: string,
  treeId: string | null,
  opts: { status?: string; cost?: number; started_at?: string; completed_at?: string; gate_results?: string; retry_count?: number; created_at?: string } = {}
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
  // created_at has a DEFAULT so override via UPDATE when a specific value is needed
  if (opts.created_at !== undefined) {
    db.run(`UPDATE tasks SET created_at = ? WHERE id = ?`, [opts.created_at, id]);
  }
}

describe("costByTree", () => {
  test("aggregates cost per tree", () => {
    insertTree("titan", "Titan");
    insertTree("grove", "Grove");
    const now = new Date().toISOString();
    insertTask("W-001", "titan", { cost: 2.5, started_at: now });
    insertTask("W-002", "titan", { cost: 1.5, started_at: now });
    insertTask("W-003", "grove", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costByTree(since);
    expect(result.length).toBe(2);

    const titan = result.find(r => r.tree_name === "Titan");
    expect(titan!.total_cost).toBe(4.0);
    expect(titan!.task_count).toBe(2);

    const grove = result.find(r => r.tree_name === "Grove");
    expect(grove!.total_cost).toBe(3.0);
    expect(grove!.task_count).toBe(1);
  });

  test("returns empty array when no tasks in range", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(db.costByTree(future)).toEqual([]);
  });

  test("excludes tasks without a tree", () => {
    const now = new Date().toISOString();
    insertTask("W-001", null, { cost: 5.0, started_at: now });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.costByTree(since)).toEqual([]);
  });
});

describe("costDaily", () => {
  test("groups cost by date", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { cost: 2.0, started_at: new Date().toISOString() });
    insertTask("W-002", "t", { cost: 3.0, started_at: new Date().toISOString() });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costDaily(since);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const today = result.find(r => r.date === new Date().toISOString().slice(0, 10));
    expect(today!.total_cost).toBe(5.0);
    expect(today!.task_count).toBe(2);
  });

  test("returns empty array when no tasks", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(db.costDaily(future)).toEqual([]);
  });
});

describe("costTopTasks", () => {
  test("returns tasks sorted by cost descending", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { cost: 1.0, started_at: now });
    insertTask("W-002", "t", { cost: 5.0, started_at: now });
    insertTask("W-003", "t", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.costTopTasks(since, 2);
    expect(result.length).toBe(2);
    expect(result[0].task_id).toBe("W-002");
    expect(result[0].cost_usd).toBe(5.0);
    expect(result[1].task_id).toBe("W-003");
  });

  test("respects limit parameter", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { cost: 1.0, started_at: now });
    insertTask("W-002", "t", { cost: 2.0, started_at: now });
    insertTask("W-003", "t", { cost: 3.0, started_at: now });

    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.costTopTasks(since, 1).length).toBe(1);
  });
});

describe("gateAnalytics", () => {
  test("aggregates pass/fail by gate type", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", {
      status: "completed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: true }, lint: { passed: true } }),
    });
    insertTask("W-002", "t", {
      status: "failed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: false, reason: "2 failures" }, lint: { passed: true } }),
    });
    insertTask("W-003", "t", {
      status: "completed", started_at: now,
      gate_results: JSON.stringify({ tests: { passed: true }, diff_size: { passed: false, reason: "too large" } }),
    });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.gateAnalytics(since);

    const tests = result.find(r => r.gate_type === "tests");
    expect(tests!.pass_count).toBe(2);
    expect(tests!.fail_count).toBe(1);
    expect(tests!.total).toBe(3);

    const lint = result.find(r => r.gate_type === "lint");
    expect(lint!.pass_count).toBe(2);
    expect(lint!.fail_count).toBe(0);

    const diff = result.find(r => r.gate_type === "diff_size");
    expect(diff!.pass_count).toBe(0);
    expect(diff!.fail_count).toBe(1);
  });

  test("returns empty when no gate_results", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { started_at: new Date().toISOString() });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.gateAnalytics(since)).toEqual([]);
  });
});

describe("retryStats", () => {
  test("aggregates retry statistics", () => {
    insertTree("t", "T");
    const now = new Date().toISOString();
    insertTask("W-001", "t", { started_at: now, retry_count: 2 });
    insertTask("W-002", "t", { started_at: now, retry_count: 0 });
    insertTask("W-003", "t", { started_at: now, retry_count: 3 });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.retryStats(since);
    expect(result.total_retried).toBe(2);
    expect(result.avg_retries).toBe(2.5);
    expect(result.max_retries).toBe(3);
  });

  test("returns zeros when no retries", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { started_at: new Date().toISOString(), retry_count: 0 });
    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.retryStats(since);
    expect(result.total_retried).toBe(0);
    expect(result.avg_retries).toBe(0);
    expect(result.max_retries).toBe(0);
  });
});

describe("taskTimeline", () => {
  test("returns tasks with timing data ordered by started_at", () => {
    insertTree("t", "T");
    const t1 = new Date(Date.now() - 3600000).toISOString();
    const t2 = new Date(Date.now() - 1800000).toISOString();
    insertTask("W-001", "t", { status: "completed", started_at: t1, completed_at: t2 });
    insertTask("W-002", "t", { status: "active", started_at: t2 });

    const since = new Date(Date.now() - 86400000).toISOString();
    const result = db.taskTimeline(since);
    expect(result.length).toBe(2);
    expect(result[0].task_id).toBe("W-001");
    expect(result[0].tree_name).toBe("T");
    expect(result[0].started_at).toBe(t1);
    expect(result[1].task_id).toBe("W-002");
    expect(result[1].completed_at).toBeNull();
  });

  test("excludes tasks without started_at", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "draft" });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(db.taskTimeline(since)).toEqual([]);
  });
});
