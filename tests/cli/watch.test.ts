import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { bus } from "../../src/broker/event-bus";
import {
  parseArgs,
  parseDuration,
  wireEventListeners,
  type TaskState,
  type WatchOptions,
} from "../../src/cli/commands/watch-core";

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  test("parses seconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
  });

  test("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  test("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("returns undefined for invalid input", () => {
    expect(parseDuration("abc")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("30")).toBeUndefined();
    expect(parseDuration("5d")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses single task from --tree and --title", () => {
    const opts = parseArgs(["--tree", "myrepo", "--title", "Fix bug"]);
    expect(opts).not.toBeNull();
    expect(opts!.tasks).toHaveLength(1);
    expect(opts!.tasks[0].tree).toBe("myrepo");
    expect(opts!.tasks[0].title).toBe("Fix bug");
  });

  test("parses optional --path and --description", () => {
    const opts = parseArgs([
      "--tree", "myrepo",
      "--title", "Add tests",
      "--path", "adversarial",
      "--description", "Add integration tests for auth module",
    ]);
    expect(opts!.tasks[0].path).toBe("adversarial");
    expect(opts!.tasks[0].description).toBe("Add integration tests for auth module");
  });

  test("parses --timeout flag", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "--timeout", "30m"]);
    expect(opts!.timeout).toBe(1_800_000);
  });

  test("parses --budget flag", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "--budget", "5.00"]);
    expect(opts!.budget).toBe(5.0);
  });

  test("parses --no-merge flag", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "--no-merge"]);
    expect(opts!.noMerge).toBe(true);
  });

  test("parses --json flag", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "--json"]);
    expect(opts!.json).toBe(true);
  });

  test("parses --verbose flag", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "--verbose"]);
    expect(opts!.verbose).toBe(true);
  });

  test("parses -v as verbose", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t", "-v"]);
    expect(opts!.verbose).toBe(true);
  });

  test("returns null for --help", () => {
    expect(parseArgs(["--help"])).toBeNull();
    expect(parseArgs(["-h"])).toBeNull();
  });

  test("returns null when --tree is missing", () => {
    expect(parseArgs(["--title", "Fix bug"])).toBeNull();
  });

  test("returns null when --title is missing", () => {
    expect(parseArgs(["--tree", "myrepo"])).toBeNull();
  });

  test("parses --tasks from JSON file", () => {
    const dir = join(tmpdir(), "grove-test-watch-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tasks.json");
    writeFileSync(file, JSON.stringify([
      { title: "Task A", tree: "repo1" },
      { title: "Task B", tree: "repo2", path: "research" },
    ]));

    const opts = parseArgs(["--tasks", file]);
    expect(opts).not.toBeNull();
    expect(opts!.tasks).toHaveLength(2);
    expect(opts!.tasks[0].title).toBe("Task A");
    expect(opts!.tasks[1].path).toBe("research");

    rmSync(dir, { recursive: true, force: true });
  });

  test("parses --tasks with { tasks: [...] } wrapper", () => {
    const dir = join(tmpdir(), "grove-test-watch-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tasks.json");
    writeFileSync(file, JSON.stringify({
      tasks: [{ title: "Task C", tree: "repo3" }],
    }));

    const opts = parseArgs(["--tasks", file]);
    expect(opts!.tasks).toHaveLength(1);
    expect(opts!.tasks[0].title).toBe("Task C");

    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null for missing tasks file", () => {
    expect(parseArgs(["--tasks", "/nonexistent/tasks.json"])).toBeNull();
  });

  test("returns null for invalid timeout", () => {
    expect(parseArgs(["--tree", "r", "--title", "t", "--timeout", "abc"])).toBeNull();
  });

  test("returns null for invalid budget", () => {
    expect(parseArgs(["--tree", "r", "--title", "t", "--budget", "nope"])).toBeNull();
  });

  test("defaults noMerge, json, verbose to false", () => {
    const opts = parseArgs(["--tree", "r", "--title", "t"]);
    expect(opts!.noMerge).toBe(false);
    expect(opts!.json).toBe(false);
    expect(opts!.verbose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wireEventListeners
// ---------------------------------------------------------------------------

describe("wireEventListeners", () => {
  const makeWatched = (id: string): Map<string, TaskState> => {
    const map = new Map<string, TaskState>();
    map.set(id, {
      id,
      title: "Test task",
      status: "queued",
      startedAt: Date.now(),
      cost: 0,
      tokens: 0,
    });
    return map;
  };

  const defaultOpts: WatchOptions = {
    tasks: [],
    noMerge: false,
    json: false,
    verbose: false,
  };

  afterEach(() => {
    // Clean up all bus handlers to avoid test leakage
    bus.removeAll();
  });

  test("updates task status on task:status events", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, defaultOpts);

    bus.emit("task:status", { taskId: "W-001", status: "active" });
    expect(watched.get("W-001")!.status).toBe("active");

    bus.emit("task:status", { taskId: "W-001", status: "completed" });
    expect(watched.get("W-001")!.status).toBe("completed");

    for (const unsub of unsubs) unsub();
  });

  test("ignores events for unwatched tasks", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, defaultOpts);

    bus.emit("task:status", { taskId: "W-999", status: "failed" });
    // Should not throw or affect watched tasks
    expect(watched.get("W-001")!.status).toBe("queued");
    expect(watched.has("W-999")).toBe(false);

    for (const unsub of unsubs) unsub();
  });

  test("tracks cost from cost:updated events", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, defaultOpts);

    bus.emit("cost:updated", { taskId: "W-001", usd: 0.47, tokens: 12000 });
    expect(watched.get("W-001")!.cost).toBe(0.47);
    expect(watched.get("W-001")!.tokens).toBe(12000);

    for (const unsub of unsubs) unsub();
  });

  test("tracks PR info from merge:pr_created events", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, defaultOpts);

    bus.emit("merge:pr_created", { taskId: "W-001", prNumber: 42, prUrl: "https://github.com/org/repo/pull/42" });
    expect(watched.get("W-001")!.prNumber).toBe(42);
    expect(watched.get("W-001")!.prUrl).toBe("https://github.com/org/repo/pull/42");

    for (const unsub of unsubs) unsub();
  });

  test("budget enforcement marks task failed", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, { ...defaultOpts, budget: 5.0 });

    bus.emit("cost:updated", { taskId: "W-001", usd: 5.50, tokens: 50000 });
    expect(watched.get("W-001")!.status).toBe("failed");
    expect(watched.get("W-001")!.failReason).toBe("budget_exceeded");

    for (const unsub of unsubs) unsub();
  });

  test("budget enforcement does not trigger below limit", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, { ...defaultOpts, budget: 5.0 });

    bus.emit("cost:updated", { taskId: "W-001", usd: 3.00, tokens: 30000 });
    expect(watched.get("W-001")!.status).toBe("queued"); // unchanged

    for (const unsub of unsubs) unsub();
  });

  test("--no-merge stops task at merge step", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, { ...defaultOpts, noMerge: true });

    bus.emit("task:updated", { taskId: "W-001", field: "current_step", value: "merge" });
    expect(watched.get("W-001")!.status).toBe("completed");
    expect(watched.get("W-001")!.failReason).toBe("no_merge_stop");

    for (const unsub of unsubs) unsub();
  });

  test("--no-merge does not affect non-merge steps", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, { ...defaultOpts, noMerge: true });

    bus.emit("task:updated", { taskId: "W-001", field: "current_step", value: "implement" });
    expect(watched.get("W-001")!.status).toBe("queued"); // unchanged

    for (const unsub of unsubs) unsub();
  });

  test("unsubscribe functions clean up", () => {
    const watched = makeWatched("W-001");
    const unsubs: Array<() => void> = [];
    wireEventListeners(watched, unsubs, defaultOpts);

    expect(unsubs.length).toBeGreaterThan(0);

    for (const unsub of unsubs) unsub();

    // After cleanup, events should not update state
    bus.emit("task:status", { taskId: "W-001", status: "failed" });
    expect(watched.get("W-001")!.status).toBe("queued"); // unchanged
  });
});
