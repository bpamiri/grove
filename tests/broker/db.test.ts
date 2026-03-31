import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test.db");

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

describe("Database basics", () => {
  test("creates all 5 tables", () => {
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const names = tables.map(t => t.name);
    expect(names).toContain("trees");
    expect(names).toContain("tasks");
    expect(names).toContain("sessions");
    expect(names).toContain("events");
    expect(names).toContain("messages");
  });

  test("WAL mode is enabled", () => {
    const mode = db.scalar<string>("PRAGMA journal_mode");
    expect(mode).toBe("wal");
  });
});

describe("Tree operations", () => {
  test("upsert and get a tree", () => {
    db.treeUpsert({ id: "api-server", name: "API Server", path: "/code/api-server", github: "org/api-server" });
    const tree = db.treeGet("api-server");
    expect(tree).not.toBeNull();
    expect(tree!.name).toBe("API Server");
    expect(tree!.path).toBe("/code/api-server");
    expect(tree!.github).toBe("org/api-server");
    expect(tree!.branch_prefix).toBe("grove/");
  });

  test("upsert updates existing tree", () => {
    db.treeUpsert({ id: "api", name: "API", path: "/old" });
    db.treeUpsert({ id: "api", name: "API Updated", path: "/new" });
    const tree = db.treeGet("api");
    expect(tree!.name).toBe("API Updated");
    expect(tree!.path).toBe("/new");
  });

  test("allTrees returns sorted by name", () => {
    db.treeUpsert({ id: "z-repo", name: "Z Repo", path: "/z" });
    db.treeUpsert({ id: "a-repo", name: "A Repo", path: "/a" });
    const trees = db.allTrees();
    expect(trees.length).toBe(2);
    expect(trees[0].name).toBe("A Repo");
  });

  test("treeDelete removes a tree", () => {
    db.treeUpsert({ id: "doomed", name: "Doomed", path: "/tmp/doomed" });
    expect(db.treeGet("doomed")).not.toBeNull();
    db.treeDelete("doomed");
    expect(db.treeGet("doomed")).toBeNull();
  });

  test("treeDelete is idempotent for missing tree", () => {
    // Should not throw
    db.treeDelete("nonexistent");
  });
});

describe("Task operations", () => {
  test("create and get a task", () => {
    db.run(
      "INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)",
      ["W-001", "Fix auth bug", "planned"]
    );
    const task = db.taskGet("W-001");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Fix auth bug");
    expect(task!.status).toBe("planned");
    expect(task!.cost_usd).toBe(0);
  });

  test("taskSetStatus updates and creates event", () => {
    db.run("INSERT INTO tasks (id, title) VALUES (?, ?)", ["W-001", "Test"]);
    db.taskSetStatus("W-001", "running");
    const task = db.taskGet("W-001");
    expect(task!.status).toBe("running");

    const events = db.eventsByTask("W-001");
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("status_change");
  });

  test("nextTaskId generates sequential IDs", () => {
    expect(db.nextTaskId("W")).toBe("W-001");
    db.run("INSERT INTO tasks (id, title) VALUES (?, ?)", ["W-001", "First"]);
    expect(db.nextTaskId("W")).toBe("W-002");
    db.run("INSERT INTO tasks (id, title) VALUES (?, ?)", ["W-010", "Tenth"]);
    expect(db.nextTaskId("W")).toBe("W-011");
  });

  test("tasksByStatus filters correctly", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "A", "running"]);
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-002", "B", "planned"]);
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-003", "C", "running"]);
    expect(db.tasksByStatus("running").length).toBe(2);
    expect(db.tasksByStatus("planned").length).toBe(1);
    expect(db.tasksByStatus("done").length).toBe(0);
  });

  test("taskCount with and without status filter", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "A", "running"]);
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-002", "B", "planned"]);
    expect(db.taskCount()).toBe(2);
    expect(db.taskCount("running")).toBe(1);
  });

  test("isTaskBlocked checks dependencies", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "A", "active"]);
    db.run("INSERT INTO tasks (id, title, status, depends_on) VALUES (?, ?, ?, ?)", ["W-002", "B", "draft", "W-001"]);
    expect(db.isTaskBlocked("W-002")).toBe(true);

    db.taskSetStatus("W-001", "completed");
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("getNewlyUnblocked finds dependent tasks", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)", ["W-001", "A", "completed"]);
    db.run("INSERT INTO tasks (id, title, status, depends_on) VALUES (?, ?, ?, ?)", ["W-002", "B", "draft", "W-001"]);
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].id).toBe("W-002");
  });

  test("subTasks returns children of parent", () => {
    db.run("INSERT INTO tasks (id, title) VALUES (?, ?)", ["T-001", "Parent"]);
    db.run("INSERT INTO tasks (id, title, parent_task_id) VALUES (?, ?, ?)", ["W-001", "Sub A", "T-001"]);
    db.run("INSERT INTO tasks (id, title, parent_task_id) VALUES (?, ?, ?)", ["W-002", "Sub B", "T-001"]);
    const subs = db.subTasks("T-001");
    expect(subs.length).toBe(2);
  });

  test("taskDeleteByTree removes all tasks for a tree", () => {
    db.treeUpsert({ id: "my-tree", name: "My Tree", path: "/tmp/tree" });
    db.treeUpsert({ id: "other", name: "Other Tree", path: "/tmp/other" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "my-tree", "Task A", "draft"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-002", "my-tree", "Task B", "active"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-003", "other", "Task C", "draft"]);

    const count = db.taskDeleteByTree("my-tree");
    expect(count).toBe(2);
    expect(db.tasksByTree("my-tree").length).toBe(0);
    // Other tree's tasks unaffected
    expect(db.taskGet("W-003")).not.toBeNull();
  });

  test("taskDeleteByTree returns 0 when no tasks", () => {
    const count = db.taskDeleteByTree("empty-tree");
    expect(count).toBe(0);
  });
});

describe("Session operations", () => {
  test("create and end a session", () => {
    db.sessionCreate("s-001", null, "orchestrator", 12345, "grove:0");
    const session = db.get<{ id: string; role: string; pid: number }>(
      "SELECT * FROM sessions WHERE id = ?", ["s-001"]
    );
    expect(session).not.toBeNull();
    expect(session!.role).toBe("orchestrator");
    expect(session!.pid).toBe(12345);

    db.sessionEnd("s-001", "completed");
    const ended = db.get<{ status: string; ended_at: string }>(
      "SELECT status, ended_at FROM sessions WHERE id = ?", ["s-001"]
    );
    expect(ended!.status).toBe("completed");
    expect(ended!.ended_at).not.toBeNull();
  });

  test("sessionUpdateCost updates cost and tokens", () => {
    db.sessionCreate("s-001", null, "worker");
    db.sessionUpdateCost("s-001", 1.23, 5000);
    const session = db.get<{ cost_usd: number; tokens_used: number }>(
      "SELECT cost_usd, tokens_used FROM sessions WHERE id = ?", ["s-001"]
    );
    expect(session!.cost_usd).toBe(1.23);
    expect(session!.tokens_used).toBe(5000);
  });
});

describe("Event operations", () => {
  test("addEvent and recentEvents", () => {
    db.addEvent("W-001", "s-001", "worker_spawned", "Worker started");
    db.addEvent("W-001", "s-001", "gate_passed", "Tests passed", "14 tests, 0 failures");
    const events = db.recentEvents(10);
    expect(events.length).toBe(2);
    expect(events[0].event_type).toBe("gate_passed"); // DESC order
  });
});

describe("Message operations", () => {
  test("addMessage and recentMessages", () => {
    db.addMessage("user", "Fix the auth bug");
    db.addMessage("orchestrator", "I'll create a task for that");
    db.addMessage("user", "Worker status for W-042", "W-042");

    const mainMsgs = db.recentMessages("main");
    expect(mainMsgs.length).toBe(2);

    const taskMsgs = db.recentMessages("W-042");
    expect(taskMsgs.length).toBe(1);
    expect(taskMsgs[0].source).toBe("user");
  });
});

describe("Cost helpers", () => {
  test("costToday returns sum for today", () => {
    db.sessionCreate("s-001", null, "worker");
    db.sessionUpdateCost("s-001", 1.50, 5000);
    db.sessionCreate("s-002", null, "worker");
    db.sessionUpdateCost("s-002", 2.50, 8000);
    expect(db.costToday()).toBe(4.0);
  });
});
