import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../fixtures/helpers";
import { createIssueForTask, formatIssueBody } from "../../src/broker/github-sync";
import type { Database } from "../../src/broker/db";

describe("formatIssueBody", () => {
  test("includes description, task ID, and path", () => {
    const body = formatIssueBody({
      id: "W-042",
      description: "Fix the login bug",
      path_name: "development",
    });
    expect(body).toContain("Fix the login bug");
    expect(body).toContain("**Task:** W-042");
    expect(body).toContain("**Path:** development");
    expect(body).toContain("Grove");
  });

  test("uses placeholder when description is null", () => {
    const body = formatIssueBody({
      id: "W-001",
      description: null,
      path_name: "research",
    });
    expect(body).toContain("No description provided.");
    expect(body).toContain("**Task:** W-001");
  });
});

describe("createIssueForTask", () => {
  let db: Database;
  let cleanup: () => void;
  let mockGhIssueCreate: ReturnType<typeof createMockGhIssueCreate>;

  function createMockGhIssueCreate(issueNumber: number = 99) {
    const calls: Array<{ repo: string; opts: { title: string; body: string } }> = [];
    const fn = (repo: string, opts: { title: string; body: string }) => {
      calls.push({ repo, opts });
      return { number: issueNumber, url: `https://github.com/${repo}/issues/${issueNumber}` };
    };
    return Object.assign(fn, { calls });
  }

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    // Create a tree with github configured
    db.treeUpsert({
      id: "my-app",
      name: "my-app",
      path: "/tmp/my-app",
      github: "owner/my-app",
      branch_prefix: "grove/",
    });
    // Create a tree without github
    db.treeUpsert({
      id: "local-only",
      name: "local-only",
      path: "/tmp/local",
    });
    mockGhIssueCreate = createMockGhIssueCreate();
  });

  afterEach(() => cleanup());

  test("creates issue and stores number for task with tree+github", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Add dark mode", "Implement dark mode toggle", "development"],
    );

    const result = createIssueForTask(db, taskId, mockGhIssueCreate);

    expect(result).toBe(99);
    expect(mockGhIssueCreate.calls).toHaveLength(1);
    expect(mockGhIssueCreate.calls[0].repo).toBe("owner/my-app");
    expect(mockGhIssueCreate.calls[0].opts.title).toBe("Add dark mode");
    expect(mockGhIssueCreate.calls[0].opts.body).toContain("Implement dark mode toggle");
    expect(mockGhIssueCreate.calls[0].opts.body).toContain(taskId);

    // Verify DB was updated
    const task = db.taskGet(taskId);
    expect(task!.github_issue).toBe(99);

    // Verify event was logged
    const events = db.eventsByTask(taskId);
    const issueEvent = events.find(e => e.event_type === "issue_created");
    expect(issueEvent).toBeDefined();
    expect(issueEvent!.summary).toContain("#99");
  });

  test("skips task that already has a github_issue", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, description, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
      [taskId, "my-app", "Imported Issue", "From GitHub", "development", 42],
    );

    const result = createIssueForTask(db, taskId, mockGhIssueCreate);

    expect(result).toBeNull();
    expect(mockGhIssueCreate.calls).toHaveLength(0);
  });

  test("skips task with no tree_id", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [taskId, null, "Orphan task", null, "development"],
    );

    const result = createIssueForTask(db, taskId, mockGhIssueCreate);

    expect(result).toBeNull();
    expect(mockGhIssueCreate.calls).toHaveLength(0);
  });

  test("skips task whose tree has no github configured", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [taskId, "local-only", "Local task", null, "development"],
    );

    const result = createIssueForTask(db, taskId, mockGhIssueCreate);

    expect(result).toBeNull();
    expect(mockGhIssueCreate.calls).toHaveLength(0);
  });

  test("returns null for nonexistent task", () => {
    const result = createIssueForTask(db, "W-999", mockGhIssueCreate);
    expect(result).toBeNull();
  });

  test("handles gh CLI failure gracefully", () => {
    const taskId = db.nextTaskId("W");
    db.run(
      "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
      [taskId, "my-app", "Will fail", null, "development"],
    );

    const failingCreate = () => {
      throw new Error("gh: authentication required");
    };

    const result = createIssueForTask(db, taskId, failingCreate);

    expect(result).toBeNull();

    // github_issue should remain null
    const task = db.taskGet(taskId);
    expect(task!.github_issue).toBeNull();

    // Failure event should be logged
    const events = db.eventsByTask(taskId);
    const failEvent = events.find(e => e.event_type === "issue_create_failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.summary).toContain("authentication required");
  });
});
