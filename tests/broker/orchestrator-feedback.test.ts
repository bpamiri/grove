import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { bus } from "../../src/broker/event-bus";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";
import type { Message } from "../../src/shared/types";

// Capture orchestrator.sendMessage calls.
// Spread the real module so mock.module doesn't break other test files
// that import the same module in the same bun process (mock.module is global).
const sentMessages: string[] = [];
const realOrchestrator = await import("../../src/agents/orchestrator");
mock.module("../../src/agents/orchestrator", () => ({
  ...realOrchestrator,
  sendMessage: (text: string) => { sentMessages.push(text); },
  isRunning: () => false,
  getSessionId: () => null,
}));

// Allow dynamic control of the proactive setting while preserving all other exports.
let proactiveValue: boolean | undefined = true;
const realConfig = await import("../../src/broker/config");
mock.module("../../src/broker/config", () => ({
  ...realConfig,
  settingsGet: (key: string) => {
    if (key === "proactive") return proactiveValue;
    return realConfig.settingsGet(key as any);
  },
}));

// Import after mocks are set up
const { wireOrchestratorFeedback, unwireOrchestratorFeedback, _getStallCounts } = await import(
  "../../src/broker/orchestrator-feedback"
);

// Capture message:new bus emissions for verifying system message broadcast.
let emittedMessages: Message[] = [];

let db: Database;
let cleanup: () => void;
let unsubMessages: () => void;

beforeEach(() => {
  sentMessages.length = 0;
  emittedMessages = [];
  proactiveValue = true;
  bus.removeAll();
  ({ db, cleanup } = createTestDb());
  db.treeUpsert({ id: "main-tree", name: "Main", path: "/code/main" });
  wireOrchestratorFeedback(db);
  // Subscribe to message:new AFTER wiring so we capture system messages from safeSend
  unsubMessages = bus.on("message:new", ({ message }) => { emittedMessages.push(message); });
});

afterEach(() => {
  unsubMessages();
  unwireOrchestratorFeedback();
  bus.removeAll();
  cleanup();
});

// ---------------------------------------------------------------------------
// Worker events
// ---------------------------------------------------------------------------

describe("worker:ended", () => {
  test("notifies orchestrator on worker failure", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "main-tree", "Fix auth bug", "active"],
    );

    bus.emit("worker:ended", { taskId: "W-001", sessionId: "s1", status: "failed" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-001");
    expect(sentMessages[0]).toContain("Fix auth bug");
    expect(sentMessages[0]).toContain("failed");
  });

  test("does not notify on worker success (step engine handles it)", () => {
    bus.emit("worker:ended", { taskId: "W-001", sessionId: "s1", status: "done" });
    expect(sentMessages).toHaveLength(0);
  });

  test("uses raw taskId when task is not in DB", () => {
    bus.emit("worker:ended", { taskId: "W-999", sessionId: "s1", status: "crashed" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-999");
    // Should not contain a title in parens since task doesn't exist
    expect(sentMessages[0]).not.toContain('("');
  });
});

// ---------------------------------------------------------------------------
// Evaluation events
// ---------------------------------------------------------------------------

describe("eval:passed", () => {
  test("sends pass notification with feedback", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "main-tree", "Add search", "active"],
    );

    bus.emit("eval:passed", { taskId: "W-002", feedback: "All gates green" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-002");
    expect(sentMessages[0]).toContain("passed evaluation");
    expect(sentMessages[0]).toContain("All gates green");
  });

  test("omits feedback clause when no feedback provided", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "main-tree", "Add search", "active"],
    );

    bus.emit("eval:passed", { taskId: "W-002" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).not.toContain("Feedback:");
    expect(sentMessages[0]).not.toContain("undefined");
  });
});

describe("eval:failed", () => {
  test("sends failure notification with retry info", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-003", "main-tree", "Refactor DB", "active", 1, 3],
    );

    bus.emit("eval:failed", { taskId: "W-003", feedback: "Tests failing: 2 suites" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-003");
    expect(sentMessages[0]).toContain("failed evaluation");
    expect(sentMessages[0]).toContain("1/3");
    expect(sentMessages[0]).toContain("Tests failing");
  });
});

// ---------------------------------------------------------------------------
// Review events
// ---------------------------------------------------------------------------

describe("review:rejected", () => {
  test("sends rejection with feedback", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-004", "main-tree", "Add API endpoint", "active"],
    );

    bus.emit("review:rejected", { taskId: "W-004", feedback: "Missing error handling for 404 case" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-004");
    expect(sentMessages[0]).toContain("review rejected");
    expect(sentMessages[0]).toContain("Missing error handling");
  });
});

describe("review:approved", () => {
  test("sends approval notification", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-005", "main-tree", "Update docs", "active"],
    );

    bus.emit("review:approved", { taskId: "W-005" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("review approved");
  });
});

// ---------------------------------------------------------------------------
// Merge events
// ---------------------------------------------------------------------------

describe("merge:pr_created", () => {
  test("sends PR creation notice", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-006", "main-tree", "Feature X", "active"],
    );

    bus.emit("merge:pr_created", { taskId: "W-006", prNumber: 42, prUrl: "https://github.com/org/repo/pull/42" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("PR #42");
    expect(sentMessages[0]).toContain("https://github.com/org/repo/pull/42");
  });
});

describe("merge:ci_failed", () => {
  test("sends CI failure notice", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-007", "main-tree", "Fix perf", "active"],
    );

    bus.emit("merge:ci_failed", { taskId: "W-007", prNumber: 55 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("CI failed");
    expect(sentMessages[0]).toContain("PR #55");
  });
});

describe("merge:completed", () => {
  test("sends merge completion notice", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-008", "main-tree", "Feature Y", "completed"],
    );

    bus.emit("merge:completed", { taskId: "W-008", prNumber: 60 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("merged");
    expect(sentMessages[0]).toContain("PR #60");
  });

  test("includes unblocked task IDs when dependencies are resolved", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-008", "main-tree", "Feature Y", "completed"],
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-020", "main-tree", "Depends on Y", "draft", "W-008"],
    );

    bus.emit("merge:completed", { taskId: "W-008", prNumber: 60 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("1 task(s) now unblocked");
    expect(sentMessages[0]).toContain("W-020");
  });
});

// ---------------------------------------------------------------------------
// Task terminal states
// ---------------------------------------------------------------------------

describe("task:status (failed)", () => {
  test("sends failure notification with step and retry info", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status, current_step, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["W-009", "main-tree", "Deploy fix", "failed", "evaluate", 3],
    );

    bus.emit("task:status", { taskId: "W-009", status: "failed" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("W-009");
    expect(sentMessages[0]).toContain("failed");
    expect(sentMessages[0]).toContain("evaluate");
    expect(sentMessages[0]).toContain("3 retries");
  });

  test("ignores non-failed statuses", () => {
    bus.emit("task:status", { taskId: "W-010", status: "active" });
    bus.emit("task:status", { taskId: "W-010", status: "completed" });
    bus.emit("task:status", { taskId: "W-010", status: "queued" });
    expect(sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Budget alerts
// ---------------------------------------------------------------------------

describe("cost:budget_warning", () => {
  test("sends budget warning", () => {
    bus.emit("cost:budget_warning", { current: 18.5, limit: 25.0, period: "day" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("$18.50");
    expect(sentMessages[0]).toContain("$25.00");
    expect(sentMessages[0]).toContain("day");
  });
});

describe("cost:budget_exceeded", () => {
  test("sends budget exceeded alert", () => {
    bus.emit("cost:budget_exceeded", { current: 26.0, limit: 25.0, period: "day" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("EXCEEDED");
    expect(sentMessages[0]).toContain("$26.00");
  });
});

// ---------------------------------------------------------------------------
// Health monitor alerts
// ---------------------------------------------------------------------------

describe("monitor:stall", () => {
  test("sends stall alert", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-011", "main-tree", "Long task", "active"],
    );

    bus.emit("monitor:stall", { taskId: "W-011", sessionId: "s1", inactiveMinutes: 10 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("stalled");
    expect(sentMessages[0]).toContain("10 minutes");
  });
});

describe("monitor:crash", () => {
  test("sends crash alert", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-012", "main-tree", "Crashy task", "active"],
    );

    bus.emit("monitor:crash", { taskId: "W-012", sessionId: "s2" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("crashed");
  });
});

// ---------------------------------------------------------------------------
// Proactive setting
// ---------------------------------------------------------------------------

describe("proactive gating", () => {
  test("suppresses all messages when proactive is false", () => {
    proactiveValue = false;

    bus.emit("worker:ended", { taskId: "W-001", sessionId: "s1", status: "failed" });
    bus.emit("eval:passed", { taskId: "W-001" });
    bus.emit("eval:failed", { taskId: "W-001", feedback: "fail" });
    bus.emit("review:rejected", { taskId: "W-001", feedback: "bad" });
    bus.emit("merge:ci_failed", { taskId: "W-001", prNumber: 1 });
    bus.emit("merge:completed", { taskId: "W-001", prNumber: 1 });
    bus.emit("cost:budget_warning", { current: 20, limit: 25, period: "day" });
    bus.emit("monitor:stall", { taskId: "W-001", sessionId: "s1", inactiveMinutes: 5 });

    expect(sentMessages).toHaveLength(0);
  });

  test("sends messages when proactive is true", () => {
    proactiveValue = true;

    bus.emit("eval:passed", { taskId: "W-001" });

    expect(sentMessages).toHaveLength(1);
  });

  test("respects runtime toggle of proactive setting", () => {
    // Start enabled
    bus.emit("eval:passed", { taskId: "W-001" });
    expect(sentMessages).toHaveLength(1);

    // Disable
    proactiveValue = false;
    bus.emit("eval:passed", { taskId: "W-001" });
    expect(sentMessages).toHaveLength(1); // No new message

    // Re-enable
    proactiveValue = true;
    bus.emit("eval:passed", { taskId: "W-001" });
    expect(sentMessages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("safeSend error handling", () => {
  test("degrades gracefully with missing task data", () => {
    // Events for tasks that don't exist in the DB — exercises the _db?.taskGet
    // fallback paths and verifies nothing crashes.
    bus.emit("eval:failed", { taskId: "NONEXISTENT", feedback: "boom" });
    bus.emit("task:status", { taskId: "NONEXISTENT", status: "failed" });
    bus.emit("merge:completed", { taskId: "NONEXISTENT", prNumber: 99 });

    // All messages should have been sent (degraded labels but not crashed)
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
    // Messages use raw taskId since task is not in DB
    expect(sentMessages[0]).toContain("NONEXISTENT");
    expect(sentMessages[0]).not.toContain('("');
  });
});

// ---------------------------------------------------------------------------
// System message broadcast (W-079)
// ---------------------------------------------------------------------------

describe("system message broadcast", () => {
  test("emits message:new with source 'system' for every event sent to orchestrator", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-050", "main-tree", "Sys msg test", "active"],
    );

    bus.emit("eval:passed", { taskId: "W-050" });

    // Orchestrator received the message
    expect(sentMessages).toHaveLength(1);
    // message:new was also emitted as a system message
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].source).toBe("system");
    expect(emittedMessages[0].channel).toBe("main");
    expect(emittedMessages[0].content).toContain("W-050");
    expect(emittedMessages[0].content).toContain("passed evaluation");
  });

  test("persists system messages to the database", () => {
    bus.emit("cost:budget_warning", { current: 10, limit: 25, period: "day" });

    const msgs = db.recentMessages("main", 10);
    const systemMsgs = msgs.filter(m => m.source === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    expect(systemMsgs.some(m => m.content.includes("$10.00"))).toBe(true);
  });

  test("does not emit system messages when proactive is false", () => {
    proactiveValue = false;

    bus.emit("eval:passed", { taskId: "W-001" });

    expect(sentMessages).toHaveLength(0);
    expect(emittedMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stall deduplication (W-079)
// ---------------------------------------------------------------------------

describe("stall deduplication", () => {
  test("sends first stall to orchestrator, suppresses subsequent stalls", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-060", "main-tree", "Stalling task", "active"],
    );

    // First stall — goes to orchestrator
    bus.emit("monitor:stall", { taskId: "W-060", sessionId: "s1", inactiveMinutes: 5 });
    expect(sentMessages).toHaveLength(1);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].content).not.toContain("×");

    // Second stall — system message only, not to orchestrator
    bus.emit("monitor:stall", { taskId: "W-060", sessionId: "s1", inactiveMinutes: 10 });
    expect(sentMessages).toHaveLength(1); // Still 1 — not forwarded
    expect(emittedMessages).toHaveLength(2);
    expect(emittedMessages[1].content).toContain("×2");

    // Third stall
    bus.emit("monitor:stall", { taskId: "W-060", sessionId: "s1", inactiveMinutes: 15 });
    expect(sentMessages).toHaveLength(1); // Still 1
    expect(emittedMessages).toHaveLength(3);
    expect(emittedMessages[2].content).toContain("×3");
  });

  test("tracks stall counts independently per task", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-061", "main-tree", "Task A", "active"],
    );
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-062", "main-tree", "Task B", "active"],
    );

    bus.emit("monitor:stall", { taskId: "W-061", sessionId: "s1", inactiveMinutes: 5 });
    bus.emit("monitor:stall", { taskId: "W-062", sessionId: "s2", inactiveMinutes: 5 });

    // Both first stalls go to orchestrator
    expect(sentMessages).toHaveLength(2);

    bus.emit("monitor:stall", { taskId: "W-061", sessionId: "s1", inactiveMinutes: 10 });
    // W-061 second stall suppressed, total still 2
    expect(sentMessages).toHaveLength(2);
    expect(emittedMessages).toHaveLength(3);
    expect(emittedMessages[2].content).toContain("×2");
  });

  test("resets stall count when worker ends", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-063", "main-tree", "Restart test", "active"],
    );

    bus.emit("monitor:stall", { taskId: "W-063", sessionId: "s1", inactiveMinutes: 5 });
    expect(sentMessages).toHaveLength(1);

    // Worker ends — resets stall counter
    bus.emit("worker:ended", { taskId: "W-063", sessionId: "s1", status: "done" });
    expect(_getStallCounts().has("W-063")).toBe(false);

    // New stall after restart — treated as first stall again
    bus.emit("monitor:stall", { taskId: "W-063", sessionId: "s2", inactiveMinutes: 5 });
    expect(sentMessages).toHaveLength(2); // New first stall forwarded
    expect(emittedMessages[emittedMessages.length - 1].content).not.toContain("×");
  });

  test("persists all stall messages to DB even when deduplicated", () => {
    db.run(
      "INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)",
      ["W-064", "main-tree", "Persist test", "active"],
    );

    bus.emit("monitor:stall", { taskId: "W-064", sessionId: "s1", inactiveMinutes: 5 });
    bus.emit("monitor:stall", { taskId: "W-064", sessionId: "s1", inactiveMinutes: 10 });
    bus.emit("monitor:stall", { taskId: "W-064", sessionId: "s1", inactiveMinutes: 15 });

    const msgs = db.recentMessages("main", 50);
    const stallMsgs = msgs.filter(m => m.source === "system" && m.content.includes("stalled"));
    expect(stallMsgs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("unwireOrchestratorFeedback", () => {
  test("removes all event handlers", () => {
    unwireOrchestratorFeedback();

    bus.emit("worker:ended", { taskId: "W-001", sessionId: "s1", status: "failed" });
    bus.emit("eval:failed", { taskId: "W-001", feedback: "fail" });
    bus.emit("merge:completed", { taskId: "W-001", prNumber: 1 });

    expect(sentMessages).toHaveLength(0);
  });
});
