import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

describe("issue-poller", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    db.treeUpsert({
      id: "my-app",
      name: "my-app",
      path: "/tmp/my-app",
      github: "owner/my-app",
      branch_prefix: "grove/",
    });
    db.treeUpsert({
      id: "other-app",
      name: "other-app",
      path: "/tmp/other-app",
      github: "owner/other-app",
      branch_prefix: "grove/",
    });
  });

  afterEach(() => cleanup());

  describe("tasksWithOpenIssues", () => {
    test("returns tasks with github_issue and non-terminal status", () => {
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-001", "my-app", "Open task", "development", "draft", 10],
      );
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-002", "my-app", "Active task", "development", "active", 11],
      );
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-003", "my-app", "Queued task", "development", "queued", 12],
      );

      const rows = db.tasksWithOpenIssues();
      expect(rows).toHaveLength(3);
      expect(rows.map(r => r.task_id).sort()).toEqual(["W-001", "W-002", "W-003"]);
      expect(rows[0].github).toBe("owner/my-app");
    });

    test("excludes tasks with terminal statuses", () => {
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-001", "my-app", "Completed task", "development", "completed", 10],
      );
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-002", "my-app", "Failed task", "development", "failed", 11],
      );
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-003", "my-app", "Closed task", "development", "closed", 12],
      );

      const rows = db.tasksWithOpenIssues();
      expect(rows).toHaveLength(0);
    });

    test("excludes tasks without github_issue", () => {
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status) VALUES (?, ?, ?, ?, ?)",
        ["W-001", "my-app", "No issue", "development", "draft"],
      );

      const rows = db.tasksWithOpenIssues();
      expect(rows).toHaveLength(0);
    });

    test("excludes tasks whose tree has no github configured", () => {
      db.treeUpsert({ id: "local", name: "local", path: "/tmp/local" });
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-001", "local", "Local task", "development", "draft", 10],
      );

      const rows = db.tasksWithOpenIssues();
      expect(rows).toHaveLength(0);
    });

    test("groups correctly across multiple repos", () => {
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-001", "my-app", "Task A", "development", "draft", 10],
      );
      db.run(
        "INSERT INTO tasks (id, tree_id, title, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, ?)",
        ["W-002", "other-app", "Task B", "development", "active", 20],
      );

      const rows = db.tasksWithOpenIssues();
      expect(rows).toHaveLength(2);
      const repos = rows.map(r => r.github).sort();
      expect(repos).toEqual(["owner/my-app", "owner/other-app"]);
    });
  });
});
