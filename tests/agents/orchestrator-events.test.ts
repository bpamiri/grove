import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseOrchestratorEvent, handleOrchestratorEvent } from "../../src/agents/orchestrator-events";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { bus } from "../../src/broker/event-bus";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "orch-events-test.db");

let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  bus.removeAll();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// ---------------------------------------------------------------------------
// parseOrchestratorEvent
// ---------------------------------------------------------------------------

describe("parseOrchestratorEvent", () => {
  test("parses valid spawn_worker event", () => {
    const line = '{"type":"spawn_worker","tree":"api","task":"W-001","prompt":"Fix auth"}';
    const event = parseOrchestratorEvent(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("spawn_worker");
    if (event!.type === "spawn_worker") {
      expect(event!.tree).toBe("api");
      expect(event!.task).toBe("W-001");
      expect(event!.prompt).toBe("Fix auth");
    }
  });

  test("parses valid user_response event", () => {
    const line = '{"type":"user_response","text":"Hello user"}';
    const event = parseOrchestratorEvent(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("user_response");
    if (event!.type === "user_response") {
      expect(event!.text).toBe("Hello user");
    }
  });

  test("parses valid task_update event", () => {
    const line = '{"type":"task_update","task":"W-001","field":"status","value":"completed"}';
    const event = parseOrchestratorEvent(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("task_update");
    if (event!.type === "task_update") {
      expect(event!.task).toBe("W-001");
      expect(event!.field).toBe("status");
      expect(event!.value).toBe("completed");
    }
  });

  test("returns null for non-JSON input", () => {
    expect(parseOrchestratorEvent("this is plain text")).toBeNull();
    expect(parseOrchestratorEvent("not { valid json")).toBeNull();
    expect(parseOrchestratorEvent("❯ some prompt")).toBeNull();
  });

  test("returns null for JSON without type field", () => {
    expect(parseOrchestratorEvent('{"task":"W-001","field":"status"}')).toBeNull();
    expect(parseOrchestratorEvent('{"foo":"bar"}')).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseOrchestratorEvent("")).toBeNull();
    expect(parseOrchestratorEvent("   ")).toBeNull();
  });

  test("handles leading/trailing whitespace", () => {
    const line = '  {"type":"user_response","text":"hi"}  ';
    const event = parseOrchestratorEvent(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("user_response");
  });

  test("returns null for array JSON", () => {
    expect(parseOrchestratorEvent('[{"type":"foo"}]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleOrchestratorEvent — spawn_worker
// ---------------------------------------------------------------------------

describe("handleOrchestratorEvent — spawn_worker", () => {
  test("emits task:created with full Task object", () => {
    let received: any = null;
    const unsub = bus.on("task:created", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "spawn_worker", tree: "api", task: "W-010", prompt: "Implement feature X" },
      db
    );

    expect(received).not.toBeNull();
    expect(received.task.id).toBe("W-010");
    expect(received.task.tree_id).toBe("api");
    expect(received.task.title).toBe("Implement feature X");
    expect(received.task.status).toBe("queued");
    expect(received.task.path_name).toBe("development");
    expect(received.task.depends_on).toBeNull();
    expect(received.task.cost_usd).toBe(0);
    expect(received.task.retry_count).toBe(0);
    expect(received.task.max_retries).toBe(2);
    unsub();
  });

  test("populates depends_on when provided", () => {
    let received: any = null;
    const unsub = bus.on("task:created", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "spawn_worker", tree: "api", task: "W-011", prompt: "After W-010", depends_on: "W-010" },
      db
    );

    expect(received.task.depends_on).toBe("W-010");
    unsub();
  });
});

// ---------------------------------------------------------------------------
// handleOrchestratorEvent — user_response
// ---------------------------------------------------------------------------

describe("handleOrchestratorEvent — user_response", () => {
  test("adds message to DB and emits message:new", () => {
    let received: any = null;
    const unsub = bus.on("message:new", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "user_response", text: "Task W-001 is now in progress" },
      db
    );

    // Check DB
    const msgs = db.recentMessages("main");
    expect(msgs.length).toBe(1);
    expect(msgs[0].source).toBe("orchestrator");
    expect(msgs[0].content).toBe("Task W-001 is now in progress");

    // Check bus event
    expect(received).not.toBeNull();
    expect(received.message.source).toBe("orchestrator");
    expect(received.message.channel).toBe("main");
    expect(received.message.content).toBe("Task W-001 is now in progress");
    unsub();
  });
});

// ---------------------------------------------------------------------------
// handleOrchestratorEvent — task_update
// ---------------------------------------------------------------------------

describe("handleOrchestratorEvent — task_update", () => {
  beforeEach(() => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "Test task", "active"]);
  });

  test("completed sets current_step=$done and completed_at", () => {
    let received: any = null;
    const unsub = bus.on("task:status", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "task_update", task: "W-001", field: "status", value: "completed" },
      db
    );

    const task = db.taskGet("W-001");
    expect(task!.status).toBe("completed");
    expect(task!.current_step).toBe("$done");
    expect(task!.completed_at).not.toBeNull();

    expect(received).toEqual({ taskId: "W-001", status: "completed" });

    const events = db.eventsByTask("W-001");
    expect(events.some(e => e.event_type === "task_completed")).toBe(true);
    unsub();
  });

  test("failed sets current_step=$fail", () => {
    let received: any = null;
    const unsub = bus.on("task:status", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "task_update", task: "W-001", field: "status", value: "failed" },
      db
    );

    const task = db.taskGet("W-001");
    expect(task!.status).toBe("failed");
    expect(task!.current_step).toBe("$fail");

    expect(received).toEqual({ taskId: "W-001", status: "failed" });

    const events = db.eventsByTask("W-001");
    expect(events.some(e => e.event_type === "task_failed")).toBe(true);
    unsub();
  });

  test("other status uses taskSetStatus", () => {
    let received: any = null;
    const unsub = bus.on("task:status", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "task_update", task: "W-001", field: "status", value: "queued" },
      db
    );

    const task = db.taskGet("W-001");
    expect(task!.status).toBe("queued");

    expect(received).toEqual({ taskId: "W-001", status: "queued" });

    // taskSetStatus adds a status_change event
    const events = db.eventsByTask("W-001");
    expect(events.some(e => e.event_type === "status_change")).toBe(true);
    unsub();
  });

  test("non-status field is ignored", () => {
    let received: any = null;
    const unsub = bus.on("task:status", (data) => { received = data; });

    handleOrchestratorEvent(
      { type: "task_update", task: "W-001", field: "priority", value: 5 },
      db
    );

    // No bus event, no DB change
    expect(received).toBeNull();
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("active"); // unchanged
    unsub();
  });
});
