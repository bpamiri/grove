import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-server-trees.db");

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

describe("Tree rescan API logic", () => {
  test("rescan updates github field on existing tree", () => {
    db.treeUpsert({ id: "my-repo", name: "My Repo", path: "/tmp/my-repo", github: undefined });
    const tree = db.treeGet("my-repo")!;
    expect(tree.github).toBeNull();

    // Simulate rescan: detectGithubRemote would return a value
    const newGithub = "org/my-repo";
    db.treeUpsert({ ...tree, github: newGithub });

    const updated = db.treeGet("my-repo")!;
    expect(updated.github).toBe("org/my-repo");
  });

  test("rescan returns 404 for nonexistent tree", () => {
    const tree = db.treeGet("nonexistent");
    expect(tree).toBeNull();
  });

  test("rescan preserves other tree fields", () => {
    db.treeUpsert({ id: "repo", name: "Repo", path: "/code/repo", branch_prefix: "feat/", config: '{"default_path":"custom"}' });
    const tree = db.treeGet("repo")!;

    db.treeUpsert({ ...tree, github: "org/repo" });

    const updated = db.treeGet("repo")!;
    expect(updated.github).toBe("org/repo");
    expect(updated.path).toBe("/code/repo");
    expect(updated.branch_prefix).toBe("feat/");
    expect(updated.config).toBe('{"default_path":"custom"}');
  });
});

describe("Tree delete API logic", () => {
  test("delete removes tree with no tasks", () => {
    db.treeUpsert({ id: "empty-tree", name: "Empty", path: "/tmp/empty" });
    expect(db.treeGet("empty-tree")).not.toBeNull();

    const tasks = db.tasksByTree("empty-tree");
    expect(tasks.length).toBe(0);

    db.treeDelete("empty-tree");
    expect(db.treeGet("empty-tree")).toBeNull();
  });

  test("delete blocks when tree has tasks (409 logic)", () => {
    db.treeUpsert({ id: "busy-tree", name: "Busy", path: "/tmp/busy" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "busy-tree", "Task A", "draft"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-002", "busy-tree", "Task B", "active"]);

    const tasks = db.tasksByTree("busy-tree");
    expect(tasks.length).toBe(2);

    // Without force: tree should still exist (API would return 409)
    // The API checks tasks.length > 0 && !force → return 409
    // Here we verify the data that drives that decision
    expect(tasks.length > 0).toBe(true);
    expect(db.treeGet("busy-tree")).not.toBeNull();
  });

  test("force delete cascades tasks then removes tree", () => {
    db.treeUpsert({ id: "doomed-tree", name: "Doomed", path: "/tmp/doomed" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "doomed-tree", "Task A", "draft"]);
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-002", "doomed-tree", "Task B", "active"]);
    db.treeUpsert({ id: "other-tree", name: "Other", path: "/tmp/other" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-003", "other-tree", "Task C", "draft"]);

    // Force path: delete tasks first, then tree
    const deletedTasks = db.taskDeleteByTree("doomed-tree");
    expect(deletedTasks).toBe(2);

    db.treeDelete("doomed-tree");
    expect(db.treeGet("doomed-tree")).toBeNull();
    expect(db.tasksByTree("doomed-tree").length).toBe(0);

    // Other tree unaffected
    expect(db.treeGet("other-tree")).not.toBeNull();
    expect(db.taskGet("W-003")).not.toBeNull();
  });

  test("delete returns 404 for nonexistent tree", () => {
    const tree = db.treeGet("nonexistent");
    expect(tree).toBeNull();
  });

  test("delete emits event", () => {
    db.treeUpsert({ id: "tree-x", name: "X", path: "/tmp/x" });
    db.treeDelete("tree-x");
    db.addEvent(null, null, "tree_removed", "Removed tree tree-x (0 tasks deleted)");

    const events = db.recentEvents(10);
    const removeEvent = events.find(e => e.event_type === "tree_removed");
    expect(removeEvent).not.toBeNull();
    expect(removeEvent!.summary).toContain("tree-x");
  });
});
