// Grove v3 — Notification dispatcher unit tests
import { describe, test, expect } from "bun:test";
import { buildNotification, shouldNotify } from "../../src/notifications/dispatcher";

// ---------------------------------------------------------------------------
// buildNotification
// ---------------------------------------------------------------------------

describe("buildNotification", () => {
  test("task_failed → severity error, title contains task ID, body contains feedback", () => {
    const n = buildNotification("task_failed", {
      taskId: "W-007",
      feedback: "Tests did not pass",
    });
    expect(n.severity).toBe("error");
    expect(n.title).toContain("W-007");
    expect(n.body).toContain("Tests did not pass");
  });

  test("pr_merged → severity info, body contains PR number", () => {
    const n = buildNotification("pr_merged", { prNumber: 42 });
    expect(n.severity).toBe("info");
    expect(n.body).toContain("42");
  });

  test("budget_warning → severity warning, body contains spend amounts", () => {
    const n = buildNotification("budget_warning", { current: 8.5, limit: 10.0 });
    expect(n.severity).toBe("warning");
    expect(n.body).toContain("8.50");
    expect(n.body).toContain("10.00");
  });

  test("task_completed → severity info", () => {
    const n = buildNotification("task_completed", { taskId: "W-001", title: "My task" });
    expect(n.severity).toBe("info");
    expect(n.title).toContain("W-001");
  });

  test("gate_failed → severity warning", () => {
    const n = buildNotification("gate_failed", { feedback: "lint errors" });
    expect(n.severity).toBe("warning");
    expect(n.body).toContain("lint errors");
  });

  test("ci_failed → severity error", () => {
    const n = buildNotification("ci_failed", {});
    expect(n.severity).toBe("error");
  });

  test("budget_exceeded → severity error", () => {
    const n = buildNotification("budget_exceeded", { current: 12.0, limit: 10.0 });
    expect(n.severity).toBe("error");
    expect(n.body).toContain("12.00");
    expect(n.body).toContain("10.00");
  });

  test("orchestrator_crashed → severity error", () => {
    const n = buildNotification("orchestrator_crashed", {});
    expect(n.severity).toBe("error");
  });

  test("unknown event → severity info, title contains event name", () => {
    const n = buildNotification("some_custom_event", {});
    expect(n.severity).toBe("info");
    expect(n.title).toContain("some_custom_event");
  });
});

// ---------------------------------------------------------------------------
// shouldNotify
// ---------------------------------------------------------------------------

describe("shouldNotify", () => {
  test("true when event is in routes", () => {
    expect(shouldNotify("task_failed", { task_failed: ["slack"] })).toBe(true);
  });

  test("false when event is not in routes", () => {
    expect(shouldNotify("task_failed", { pr_merged: ["slack"] })).toBe(false);
  });

  test("false for empty routes", () => {
    expect(shouldNotify("task_failed", {})).toBe(false);
  });

  test("false when channel list is empty array", () => {
    expect(shouldNotify("task_failed", { task_failed: [] })).toBe(false);
  });
});
