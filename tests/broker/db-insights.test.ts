import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-insights.db");

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
  opts: {
    status?: string; cost?: number; path_name?: string;
    gate_results?: string; retry_count?: number; created_at?: string;
  } = {}
) {
  db.run(
    `INSERT INTO tasks (id, tree_id, title, status, cost_usd, path_name, gate_results, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, treeId, `Task ${id}`, opts.status ?? "completed",
      opts.cost ?? 0, opts.path_name ?? "development",
      opts.gate_results ?? null, opts.retry_count ?? 0,
    ]
  );
  if (opts.created_at !== undefined) {
    db.run(`UPDATE tasks SET created_at = ? WHERE id = ?`, [opts.created_at, id]);
  }
}

/** Build a gate_results JSON array in the evaluator's GateResult[] format */
function gateResults(...gates: { gate: string; passed: boolean; message: string; tier?: string }[]): string {
  return JSON.stringify(gates.map(g => ({
    gate: g.gate,
    passed: g.passed,
    tier: g.tier ?? "hard",
    message: g.message,
  })));
}

const since = new Date(Date.now() - 7 * 86400000).toISOString();

describe("insightsFailingGates", () => {
  test("ranks gates by failure count with top message", () => {
    insertTree("t", "T");
    // CI fails 3 times with same message
    insertTask("W-001", "t", { status: "failed", gate_results: gateResults({ gate: "ci", passed: false, message: "2 tests failed" }) });
    insertTask("W-002", "t", { status: "failed", gate_results: gateResults({ gate: "ci", passed: false, message: "2 tests failed" }) });
    insertTask("W-003", "t", { status: "failed", gate_results: gateResults({ gate: "ci", passed: false, message: "timeout" }) });
    // Lint fails once
    insertTask("W-004", "t", { status: "failed", gate_results: gateResults({ gate: "lint", passed: false, message: "unused import" }) });

    const result = db.insightsFailingGates(since);
    expect(result.length).toBe(2);
    expect(result[0].gate).toBe("ci");
    expect(result[0].fail_count).toBe(3);
    expect(result[0].top_message).toBe("2 tests failed");
    expect(result[0].top_message_count).toBe(2);
    expect(result[1].gate).toBe("lint");
    expect(result[1].fail_count).toBe(1);
  });

  test("ignores passing gates", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { gate_results: gateResults({ gate: "ci", passed: true, message: "ok" }) });

    const result = db.insightsFailingGates(since);
    expect(result).toEqual([]);
  });

  test("returns empty when no gate data", () => {
    expect(db.insightsFailingGates(since)).toEqual([]);
  });
});

describe("insightsRetriesByPath", () => {
  test("groups retry stats by path", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "completed", path_name: "development", retry_count: 2 });
    insertTask("W-002", "t", { status: "completed", path_name: "development", retry_count: 0 });
    insertTask("W-003", "t", { status: "failed", path_name: "adversarial", retry_count: 3 });

    const result = db.insightsRetriesByPath(since);
    expect(result.length).toBe(2);

    // adversarial has higher avg retries, so it should be first (ORDER BY avg_retries DESC)
    const adv = result.find(r => r.path_name === "adversarial")!;
    expect(adv.task_count).toBe(1);
    expect(adv.retried_count).toBe(1);
    expect(adv.avg_retries).toBe(3);
    expect(adv.max_retries).toBe(3);

    const dev = result.find(r => r.path_name === "development")!;
    expect(dev.task_count).toBe(2);
    expect(dev.retried_count).toBe(1);
    expect(dev.avg_retries).toBe(2);
    expect(dev.max_retries).toBe(2);
  });

  test("excludes non-terminal tasks", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "active", retry_count: 5 });

    const result = db.insightsRetriesByPath(since);
    expect(result).toEqual([]);
  });
});

describe("insightsTreeFailureRates", () => {
  test("computes success rate per tree", () => {
    insertTree("titan", "Titan");
    insertTree("grove", "Grove");
    insertTask("W-001", "titan", { status: "completed" });
    insertTask("W-002", "titan", { status: "completed" });
    insertTask("W-003", "titan", { status: "failed" });
    insertTask("W-004", "grove", { status: "failed" });

    const result = db.insightsTreeFailureRates(since);
    expect(result.length).toBe(2);

    // Ordered by success_rate ASC, so grove (0%) comes first
    expect(result[0].tree_name).toBe("Grove");
    expect(result[0].success_rate).toBe(0);
    expect(result[0].failed).toBe(1);

    expect(result[1].tree_name).toBe("Titan");
    expect(result[1].success_rate).toBeCloseTo(66.7, 0);
    expect(result[1].completed).toBe(2);
    expect(result[1].failed).toBe(1);
  });

  test("returns empty when no terminal tasks", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "active" });
    expect(db.insightsTreeFailureRates(since)).toEqual([]);
  });
});

describe("insightsSuccessTrend", () => {
  test("groups by date with success rate", () => {
    insertTree("t", "T");
    const today = new Date().toISOString().slice(0, 19).replace("T", " ");
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace("T", " ");

    insertTask("W-001", "t", { status: "completed", created_at: today });
    insertTask("W-002", "t", { status: "failed", created_at: today });
    insertTask("W-003", "t", { status: "completed", created_at: yesterday });

    const result = db.insightsSuccessTrend(since);
    expect(result.length).toBe(2);

    // Ordered by date ASC
    const yDay = result[0];
    expect(yDay.completed).toBe(1);
    expect(yDay.failed).toBe(0);
    expect(yDay.success_rate).toBe(100);

    const tDay = result[1];
    expect(tDay.completed).toBe(1);
    expect(tDay.failed).toBe(1);
    expect(tDay.success_rate).toBe(50);
  });

  test("returns empty when no terminal tasks", () => {
    expect(db.insightsSuccessTrend(since)).toEqual([]);
  });
});

describe("insightsCommonFailures", () => {
  test("returns top gate/message pairs by frequency", () => {
    insertTree("t", "T");
    // Same failure 3 times
    for (let i = 1; i <= 3; i++) {
      insertTask(`W-00${i}`, "t", { status: "failed", gate_results: gateResults({ gate: "ci", passed: false, message: "npm test failed" }) });
    }
    // Different failure once
    insertTask("W-004", "t", { status: "failed", gate_results: gateResults({ gate: "lint", passed: false, message: "unused var" }) });

    const result = db.insightsCommonFailures(since);
    expect(result.length).toBe(2);
    expect(result[0].gate).toBe("ci");
    expect(result[0].message).toBe("npm test failed");
    expect(result[0].count).toBe(3);
    expect(result[1].gate).toBe("lint");
    expect(result[1].count).toBe(1);
  });

  test("respects limit", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { status: "failed", gate_results: gateResults({ gate: "ci", passed: false, message: "a" }) });
    insertTask("W-002", "t", { status: "failed", gate_results: gateResults({ gate: "lint", passed: false, message: "b" }) });

    const result = db.insightsCommonFailures(since, 1);
    expect(result.length).toBe(1);
  });

  test("returns empty when all gates pass", () => {
    insertTree("t", "T");
    insertTask("W-001", "t", { gate_results: gateResults({ gate: "ci", passed: true, message: "ok" }) });
    expect(db.insightsCommonFailures(since)).toEqual([]);
  });
});
