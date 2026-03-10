// Tests for the Database class
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-db-test-"));
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Database init", () => {
  test("creates all expected tables", () => {
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .map((r) => r.name);

    expect(tables).toContain("tasks");
    expect(tables).toContain("sessions");
    expect(tables).toContain("events");
    expect(tables).toContain("repos");
    expect(tables).toContain("config");
    expect(tables).toContain("audit_results");
    expect(tables).toContain("repo_deps");
  });

  test("creates expected indexes", () => {
    const indexes = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .map((r) => r.name);

    expect(indexes).toContain("idx_events_task_id");
    expect(indexes).toContain("idx_events_timestamp");
    expect(indexes).toContain("idx_tasks_status");
    expect(indexes).toContain("idx_tasks_repo");
    expect(indexes).toContain("idx_sessions_task_id");
  });
});

describe("Task CRUD", () => {
  test("insert and query back a task", () => {
    db.exec(
      `INSERT INTO tasks (id, repo, source_type, title, description, status, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["W-001", null, "manual", "Fix the router", "Detailed description", "ingested", 50],
    );

    const task = db.taskGet("W-001");
    expect(task).not.toBeNull();
    expect(task!.id).toBe("W-001");
    expect(task!.title).toBe("Fix the router");
    expect(task!.description).toBe("Detailed description");
    expect(task!.status).toBe("ingested");
    expect(task!.priority).toBe(50);
    expect(task!.source_type).toBe("manual");
  });

  test("taskExists returns true for existing, false for missing", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)",
      ["T-001", "manual", "Test task"],
    );
    expect(db.taskExists("T-001")).toBe(true);
    expect(db.taskExists("T-999")).toBe(false);
  });

  test("taskSet updates a field and updated_at", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)",
      ["T-001", "manual", "Test task"],
    );
    db.taskSet("T-001", "strategy", "solo");
    const task = db.taskGet("T-001");
    expect(task!.strategy).toBe("solo");
  });

  test("taskGetField returns a specific field", () => {
    db.repoUpsert({ name: "wheels", org: "x", github_full: "x/w", local_path: "/tmp/w", branch_prefix: "g/", claude_md_path: null, last_synced: null });
    db.exec(
      "INSERT INTO tasks (id, source_type, title, repo) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Test task", "wheels"],
    );
    expect(db.taskGetField("T-001", "repo")).toBe("wheels");
    expect(db.taskGetField("T-001", "title")).toBe("Test task");
  });

  test("taskCount returns correct counts", () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["T-001", "manual", "A", "ingested"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["T-002", "manual", "B", "ingested"]);
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["T-003", "manual", "C", "running"]);

    expect(db.taskCount()).toBe(3);
    expect(db.taskCount("ingested")).toBe(2);
    expect(db.taskCount("running")).toBe(1);
    expect(db.taskCount("completed")).toBe(0);
  });

  test("tasksByStatus returns ordered results", () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?)", ["T-001", "manual", "Low priority", "ready", 80]);
    db.exec("INSERT INTO tasks (id, source_type, title, status, priority) VALUES (?, ?, ?, ?, ?)", ["T-002", "manual", "High priority", "ready", 10]);

    const tasks = db.tasksByStatus("ready");
    expect(tasks.length).toBe(2);
    expect(tasks[0].id).toBe("T-002"); // higher priority (lower number) first
    expect(tasks[1].id).toBe("T-001");
  });
});

describe("nextTaskId", () => {
  test("starts at 001 for empty DB", () => {
    expect(db.nextTaskId("W")).toBe("W-001");
  });

  test("increments correctly", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["W-001", "manual", "A"]);
    expect(db.nextTaskId("W")).toBe("W-002");

    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["W-002", "manual", "B"]);
    expect(db.nextTaskId("W")).toBe("W-003");
  });

  test("handles different prefixes independently", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["W-001", "manual", "A"]);
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["T-001", "manual", "B"]);
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["T-002", "manual", "C"]);

    expect(db.nextTaskId("W")).toBe("W-002");
    expect(db.nextTaskId("T")).toBe("T-003");
    expect(db.nextTaskId("X")).toBe("X-001");
  });
});

describe("taskSetStatus", () => {
  test("updates status and logs event", () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["T-001", "manual", "Test", "ingested"]);

    db.taskSetStatus("T-001", "planned");

    const task = db.taskGet("T-001");
    expect(task!.status).toBe("planned");

    const events = db.all<{ event_type: string; summary: string }>(
      "SELECT event_type, summary FROM events WHERE task_id = ?",
      ["T-001"],
    );
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("status_change");
    expect(events[0].summary).toContain("planned");
  });

  test("logs multiple status changes", () => {
    db.exec("INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)", ["T-001", "manual", "Test", "ingested"]);

    db.taskSetStatus("T-001", "planned");
    db.taskSetStatus("T-001", "ready");
    db.taskSetStatus("T-001", "running");

    const events = db.all<{ summary: string }>(
      "SELECT summary FROM events WHERE task_id = ? AND event_type = 'status_change'",
      ["T-001"],
    );
    expect(events.length).toBe(3);
  });
});

describe("configGet/configSet", () => {
  test("round-trip a key-value pair", () => {
    db.configSet("grove_version", "0.2.0");
    expect(db.configGet("grove_version")).toBe("0.2.0");
  });

  test("returns null for missing key", () => {
    expect(db.configGet("nonexistent")).toBeNull();
  });

  test("upsert overwrites existing key", () => {
    db.configSet("theme", "dark");
    db.configSet("theme", "light");
    expect(db.configGet("theme")).toBe("light");
  });
});

describe("costToday / costWeek", () => {
  test("returns 0 with no sessions", () => {
    expect(db.costToday()).toBe(0);
    expect(db.costWeek()).toBe(0);
  });

  test("sums session costs for today", () => {
    // Insert a task first (for FK)
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["T-001", "manual", "A"]);

    // Insert sessions with today's date (default started_at is datetime('now'))
    db.exec(
      "INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)",
      ["T-001", 1.5],
    );
    db.exec(
      "INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)",
      ["T-001", 2.5],
    );

    expect(db.costToday()).toBe(4.0);
  });

  test("costWeek includes sessions from this week", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["T-001", "manual", "A"]);

    db.exec(
      "INSERT INTO sessions (task_id, status, cost_usd) VALUES (?, 'completed', ?)",
      ["T-001", 3.0],
    );

    // costWeek should include today's session
    expect(db.costWeek()).toBeGreaterThanOrEqual(3.0);
  });
});

describe("repoUpsert / repoGet", () => {
  test("round-trip a repo record", () => {
    db.repoUpsert({
      name: "wheels",
      org: "cfwheels",
      github_full: "cfwheels/wheels",
      local_path: "~/code/wheels",
      branch_prefix: "grove/",
      claude_md_path: null,
      last_synced: null,
    });

    const repo = db.repoGet("wheels");
    expect(repo).not.toBeNull();
    expect(repo!.name).toBe("wheels");
    expect(repo!.org).toBe("cfwheels");
    expect(repo!.github_full).toBe("cfwheels/wheels");
    expect(repo!.local_path).toBe("~/code/wheels");
    expect(repo!.branch_prefix).toBe("grove/");
  });

  test("upsert updates existing repo", () => {
    db.repoUpsert({
      name: "wheels",
      org: "cfwheels",
      github_full: "cfwheels/wheels",
      local_path: "~/code/wheels",
      branch_prefix: "grove/",
      claude_md_path: null,
      last_synced: null,
    });

    db.repoUpsert({
      name: "wheels",
      org: "cfwheels",
      github_full: "cfwheels/wheels",
      local_path: "~/code/wheels-v2",
      branch_prefix: "peter/",
      claude_md_path: null,
      last_synced: null,
    });

    const repo = db.repoGet("wheels");
    expect(repo!.local_path).toBe("~/code/wheels-v2");
    expect(repo!.branch_prefix).toBe("peter/");
  });

  test("returns null for missing repo", () => {
    expect(db.repoGet("nonexistent")).toBeNull();
  });

  test("allRepos returns all repos sorted", () => {
    db.repoUpsert({ name: "wheels", org: "cfwheels", github_full: "cfwheels/wheels", local_path: "~/c/w", branch_prefix: "g/", claude_md_path: null, last_synced: null });
    db.repoUpsert({ name: "titan", org: "pai", github_full: "pai/titan", local_path: "~/c/t", branch_prefix: "g/", claude_md_path: null, last_synced: null });

    const repos = db.allRepos();
    expect(repos.length).toBe(2);
    expect(repos[0].name).toBe("titan"); // alphabetical
    expect(repos[1].name).toBe("wheels");
  });
});

describe("Parameterized queries with special chars", () => {
  test("single quotes in values don't break queries", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", [
      "T-001",
      "manual",
      "Fix the 'router' module",
    ]);
    const task = db.taskGet("T-001");
    expect(task!.title).toBe("Fix the 'router' module");
  });

  test("double quotes in values", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", [
      "T-001",
      "manual",
      'Fix the "router" module',
    ]);
    const task = db.taskGet("T-001");
    expect(task!.title).toBe('Fix the "router" module');
  });

  test("semicolons and SQL keywords in values", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", [
      "T-001",
      "manual",
      "DROP TABLE tasks; -- oops",
    ]);
    const task = db.taskGet("T-001");
    expect(task!.title).toBe("DROP TABLE tasks; -- oops");
    // Verify tables still exist
    expect(db.taskCount()).toBe(1);
  });

  test("unicode characters in values", () => {
    db.configSet("greeting", "Hello, world! Hola!");
    expect(db.configGet("greeting")).toBe("Hello, world! Hola!");
  });
});

describe("Event helpers", () => {
  test("addEvent with detail", () => {
    db.exec("INSERT INTO tasks (id, source_type, title) VALUES (?, ?, ?)", ["T-001", "manual", "Test"]);

    db.addEvent("T-001", "created", "Task created", "Extra detail here");

    const events = db.recentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("created");
    expect(events[0].summary).toBe("Task created");
    expect(events[0].detail).toBe("Extra detail here");
  });

  test("addEvent without detail", () => {
    db.addEvent(null, "created", "System initialized");

    const events = db.recentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0].task_id).toBeNull();
    expect(events[0].detail).toBeNull();
  });

  test("recentEvents respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.addEvent(null, "test", `Event ${i}`);
    }
    const events = db.recentEvents(3);
    expect(events.length).toBe(3);
  });
});

describe("dependency helpers", () => {
  test("isTaskBlocked returns false when depends_on is null", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "No deps", "ready"],
    );
    expect(db.isTaskBlocked("W-001")).toBe(false);
  });

  test("isTaskBlocked returns true when dependency is not done", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "running"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Blocked task", "ready", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(true);
  });

  test("isTaskBlocked returns false when all deps are done", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "done"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked task", "ready", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("isTaskBlocked handles completed status", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Dep task", "completed"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Unblocked task", "ready", "W-001"],
    );
    expect(db.isTaskBlocked("W-002")).toBe(false);
  });

  test("isTaskBlocked with multiple deps — one incomplete", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Done dep", "done"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "manual", "Running dep", "running"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-003", "manual", "Multi-dep task", "ready", "W-001,W-002"],
    );
    expect(db.isTaskBlocked("W-003")).toBe(true);
  });

  test("isTaskBlocked returns true when dep task doesn't exist", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Missing dep task", "ready", "W-999"],
    );
    expect(db.isTaskBlocked("W-001")).toBe(true);
  });

  test("getNewlyUnblocked returns tasks whose deps are now all met", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Just finished", "done"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Was waiting", "ready", "W-001"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(1);
    expect(unblocked[0].id).toBe("W-002");
  });

  test("getNewlyUnblocked excludes tasks still blocked by other deps", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Just finished", "done"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-002", "manual", "Still running", "running"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-003", "manual", "Multi-dep", "ready", "W-001,W-002"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(0);
  });

  test("getNewlyUnblocked ignores terminal tasks", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["W-001", "manual", "Just finished", "done"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-002", "manual", "Already done", "done", "W-001"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-003", "manual", "Already completed", "completed", "W-001"],
    );
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, depends_on) VALUES (?, ?, ?, ?, ?)",
      ["W-004", "manual", "Already failed", "failed", "W-001"],
    );
    const unblocked = db.getNewlyUnblocked("W-001");
    expect(unblocked.length).toBe(0);
  });
});

describe("Session helpers", () => {
  test("sessionCreate and sessionEnd", () => {
    db.repoUpsert({ name: "wheels", org: "x", github_full: "x/w", local_path: "/tmp/w", branch_prefix: "g/", claude_md_path: null, last_synced: null });
    db.exec("INSERT INTO tasks (id, source_type, title, repo) VALUES (?, ?, ?, ?)", ["T-001", "manual", "Test", "wheels"]);

    const sessionId = db.sessionCreate("T-001");
    expect(sessionId).toBeGreaterThan(0);

    const running = db.sessionGetRunning("T-001");
    expect(running).not.toBeNull();
    expect(running!.status).toBe("running");

    db.sessionEnd(sessionId, "completed");
    const after = db.sessionGetRunning("T-001");
    expect(after).toBeNull(); // no longer running
  });
});
