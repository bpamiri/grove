import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { checkTaskBudget } from "../../src/monitor/cost";
import type { Database } from "../../src/broker/db";
import type { BudgetConfig } from "../../src/shared/types";

const budgets: BudgetConfig = {
  per_task: 5.0, per_session: 10.0, per_day: 25.0, per_week: 100.0, auto_approve_under: 2.0,
};

let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.run("INSERT INTO trees (id, name, path) VALUES ('tree1', 'Test Tree', '/tmp/tree1')");
});

afterEach(() => {
  db.close();
});

// ---- checkTaskBudget ----

describe("checkTaskBudget", () => {
  test("ok when task cost below limit", () => {
    db.run(
      `INSERT INTO tasks (id, tree_id, title, status, path_name, cost_usd)
       VALUES ('W-001', 'tree1', 'Test', 'active', 'development', 2.50)`,
    );
    const result = checkTaskBudget("W-001", db, budgets);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(2.5);
    expect(result.limit).toBe(5.0);
  });

  test("not ok when task cost exceeds limit", () => {
    db.run(
      `INSERT INTO tasks (id, tree_id, title, status, path_name, cost_usd)
       VALUES ('W-002', 'tree1', 'Test', 'active', 'development', 6.00)`,
    );
    const result = checkTaskBudget("W-002", db, budgets);
    expect(result.ok).toBe(false);
    expect(result.current).toBe(6.0);
  });

  test("handles missing task gracefully — returns ok=true, current=0", () => {
    const result = checkTaskBudget("W-999", db, budgets);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(0);
  });
});

// ---- Daily / weekly aggregation ----

describe("daily cost tracking", () => {
  test("costToday sums sessions created today", () => {
    db.sessionCreate("s-01", null, "worker");
    db.sessionCreate("s-02", null, "worker");
    db.sessionUpdateCost("s-01", 3.50, 1000);
    db.sessionUpdateCost("s-02", 1.25, 500);

    const total = db.costToday();
    expect(total).toBeCloseTo(4.75, 5);
  });

  test("costWeek sums sessions this week", () => {
    db.sessionCreate("s-10", null, "worker");
    db.sessionUpdateCost("s-10", 7.00, 2000);

    const total = db.costWeek();
    expect(total).toBeGreaterThanOrEqual(7.0);
  });
});
