import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { checkTaskBudget, checkBudgets, isSpawningPaused, resetPausedState, stopCostMonitor, startCostMonitor } from "../../src/monitor/cost";
import { bus } from "../../src/broker/event-bus";
import type { Database } from "../../src/broker/db";
import type { BudgetConfig } from "../../src/shared/types";

let db: Database;
let cleanup: () => void;

const BUDGETS: BudgetConfig = {
  per_task: 5.0,
  per_session: 10.0,
  per_day: 25.0,
  per_week: 100.0,
  auto_approve_under: 2.0,
};

beforeEach(() => {
  const result = createTestDb();
  db = result.db;
  cleanup = result.cleanup;
  resetPausedState();

  // Seed a tree and task for checkTaskBudget tests
  db.treeUpsert({ id: "t1", name: "Test", path: "/tmp/test" });
  db.run("INSERT INTO tasks (id, title, tree_id, status) VALUES (?, ?, ?, ?)", ["W-001", "Test task", "t1", "active"]);
});

afterEach(() => {
  stopCostMonitor();
  bus.removeAll("cost:budget_warning");
  bus.removeAll("cost:budget_exceeded");
  cleanup();
});

// ---------------------------------------------------------------------------
// checkTaskBudget
// ---------------------------------------------------------------------------

describe("checkTaskBudget", () => {
  test("returns ok when task cost is under budget", () => {
    db.run("UPDATE tasks SET cost_usd = 3.0 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(3.0);
    expect(result.limit).toBe(5.0);
  });

  test("returns not ok when task cost equals budget (strict <)", () => {
    db.run("UPDATE tasks SET cost_usd = 5.0 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(false);
  });

  test("returns not ok when task cost exceeds budget", () => {
    db.run("UPDATE tasks SET cost_usd = 7.5 WHERE id = 'W-001'");
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(false);
    expect(result.current).toBe(7.5);
  });

  test("returns ok with zero cost for new task", () => {
    const result = checkTaskBudget("W-001", db, BUDGETS);
    expect(result.ok).toBe(true);
    expect(result.current).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkBudgets
// ---------------------------------------------------------------------------

describe("checkBudgets", () => {
  // Helper: seed session costs for today
  function seedTodayCost(amount: number) {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.sessionCreate(id, null, "worker");
    db.sessionUpdateCost(id, amount, Math.floor(amount * 1000));
  }

  test("emits no events when daily spend is under 80%", () => {
    seedTodayCost(10.0); // 40% of 25
    const warnings: any[] = [];
    const exceeded: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    expect(warnings.length).toBe(0);
    expect(exceeded.length).toBe(0);
    expect(isSpawningPaused()).toBe(false);
  });

  test("emits budget_warning when daily spend reaches 80%", () => {
    seedTodayCost(20.0); // 80% of 25
    const warnings: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));

    checkBudgets(db, BUDGETS);

    expect(warnings.length).toBe(1);
    expect(warnings[0].period).toBe("daily");
  });

  test("emits budget_exceeded and pauses when daily spend reaches 100%", () => {
    seedTodayCost(25.0); // 100% of 25
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    expect(exceeded.length).toBe(1);
    expect(exceeded[0].period).toBe("daily");
    expect(isSpawningPaused()).toBe(true);
  });

  test("emits budget_warning when weekly spend reaches 80%", () => {
    seedTodayCost(80.0);
    const warnings: any[] = [];
    bus.on("cost:budget_warning", (e) => warnings.push(e));

    checkBudgets(db, { ...BUDGETS, per_day: 200 }); // raise daily so only weekly triggers

    expect(warnings.some((w) => w.period === "weekly")).toBe(true);
  });

  test("emits budget_exceeded when weekly spend reaches 100%", () => {
    seedTodayCost(100.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, { ...BUDGETS, per_day: 200 }); // raise daily limit

    expect(exceeded.some((e) => e.period === "weekly")).toBe(true);
    expect(isSpawningPaused()).toBe(true);
  });

  test("pauses only once when both daily and weekly exceeded", () => {
    seedTodayCost(100.0); // over both limits
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS);

    // Should get daily exceeded (pauses) but not weekly (already paused)
    expect(exceeded.length).toBe(1);
    expect(isSpawningPaused()).toBe(true);
  });

  test("unpauses when spend drops back under both limits", () => {
    // First, trigger pause
    seedTodayCost(25.0);
    checkBudgets(db, BUDGETS);
    expect(isSpawningPaused()).toBe(true);

    // Now check with very high limits (simulating spend being "under")
    checkBudgets(db, { ...BUDGETS, per_day: 1000, per_week: 5000 });
    expect(isSpawningPaused()).toBe(false);
  });

  test("does not emit duplicate budget_exceeded when already paused", () => {
    seedTodayCost(30.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    checkBudgets(db, BUDGETS); // first call — pauses, emits
    checkBudgets(db, BUDGETS); // second call — already paused, no emit

    expect(exceeded.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startCostMonitor / stopCostMonitor
// ---------------------------------------------------------------------------

describe("startCostMonitor / stopCostMonitor", () => {
  // Helper scoped for monitor tests (needs unique session IDs)
  function seedTodayCostForMonitor(amount: number) {
    const id = `s-mon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.sessionCreate(id, null, "worker");
    db.sessionUpdateCost(id, amount, Math.floor(amount * 1000));
  }

  test("is idempotent — calling start twice does not error", () => {
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    stopCostMonitor();
    // No error = pass
    expect(true).toBe(true);
  });

  test("runs an immediate check on start", () => {
    seedTodayCostForMonitor(25.0);
    const exceeded: any[] = [];
    bus.on("cost:budget_exceeded", (e) => exceeded.push(e));

    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });

    // The immediate check should have fired
    expect(exceeded.length).toBe(1);
    stopCostMonitor();
  });

  test("stop clears interval without error", () => {
    startCostMonitor({ db, budgets: BUDGETS, intervalMs: 60_000 });
    stopCostMonitor();
    stopCostMonitor(); // double stop is safe
    expect(true).toBe(true);
  });
});
