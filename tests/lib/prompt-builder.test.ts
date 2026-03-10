// Tests for prompt-builder (slugify, buildPrompt, buildResumePrompt)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";
import { slugify, buildPrompt, buildResumePrompt } from "../../src/lib/prompt-builder";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-prompt-test-"));
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("slugify", () => {
  test("lowercases text", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("replaces special chars with hyphens", () => {
    expect(slugify("fix: the router!")).toBe("fix-the-router");
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("one---two---three")).toBe("one-two-three");
  });

  test("max 50 chars", () => {
    const long = "this is a very long title that should be truncated to fifty characters maximum";
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  test("does not end with hyphen after truncation", () => {
    const input = "a".repeat(49) + " b";
    const result = slugify(input);
    expect(result.endsWith("-")).toBe(false);
  });

  test("handles numbers and alphanumeric", () => {
    expect(slugify("version 2.0 release")).toBe("version-2-0-release");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("handles pure special chars", () => {
    expect(slugify("!!!@@@###")).toBe("");
  });
});

describe("buildPrompt", () => {
  test("includes task title", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix the login page", "ready"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("T-001");
    expect(prompt).toContain("Fix the login page");
  });

  test("includes strategy instructions for solo", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, strategy) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready", "solo"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("sole worker");
  });

  test("includes strategy instructions for team", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, strategy) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Refactor auth", "ready", "team"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("one worker in a team");
  });

  test("includes strategy instructions for sweep", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, strategy) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Audit modules", "ready", "sweep"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("sweep task");
  });

  test("includes branch name", () => {
    db.repoUpsert({
      name: "wheels",
      org: "cfwheels",
      github_full: "cfwheels/wheels",
      local_path: tempDir,
      branch_prefix: "grove/",
      claude_md_path: null,
      last_synced: null,
    });
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["W-001", "manual", "Fix the router", "ready", "wheels"],
    );

    const prompt = buildPrompt("W-001", db);
    expect(prompt).toContain("grove/W-001-fix-the-router");
  });

  test("includes description if present", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, description, status) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "The login form crashes on empty submit", "ready"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("login form crashes");
  });

  test("includes session summary instructions", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("session-summary.md");
    expect(prompt).toContain("Session Summary Instructions");
  });

  test("includes source info for github_issue", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, source_ref, title, status) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "github_issue", "cfwheels/wheels#42", "Fix issue", "ready"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("GitHub Issue: cfwheels/wheels#42");
  });

  test("throws for nonexistent task", () => {
    expect(() => buildPrompt("NOPE", db)).toThrow("Task not found");
  });

  test("includes CLAUDE.md content when repo has it", () => {
    // Write a CLAUDE.md in the temp dir
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Test Repo Instructions\nUse TypeScript.");

    db.repoUpsert({
      name: "testrepo",
      org: "test",
      github_full: "test/testrepo",
      local_path: tempDir,
      branch_prefix: "grove/",
      claude_md_path: null,
      last_synced: null,
    });
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, repo) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix something", "ready", "testrepo"],
    );

    const prompt = buildPrompt("T-001", db);
    expect(prompt).toContain("Use TypeScript");
  });
});

describe("buildResumePrompt", () => {
  test("includes session_summary from previous session", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, session_summary) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "Fixed half the routes. Need to handle edge cases."],
    );

    const prompt = buildResumePrompt("T-001", db);
    expect(prompt).toContain("Resuming Task: T-001");
    expect(prompt).toContain("Fixed half the routes");
  });

  test("includes files_modified", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, files_modified) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "src/router.ts, src/index.ts"],
    );

    const prompt = buildResumePrompt("T-001", db);
    expect(prompt).toContain("src/router.ts");
    expect(prompt).toContain("src/index.ts");
  });

  test("includes next_steps", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, next_steps) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "Add error handling for edge cases"],
    );

    const prompt = buildResumePrompt("T-001", db);
    expect(prompt).toContain("Add error handling for edge cases");
  });

  test("includes branch info", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, branch) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "grove/T-001-fix-bug"],
    );

    const prompt = buildResumePrompt("T-001", db);
    expect(prompt).toContain("grove/T-001-fix-bug");
  });

  test("handles missing previous session data gracefully", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused"],
    );

    const prompt = buildResumePrompt("T-001", db);
    expect(prompt).toContain("No previous session summary");
    expect(prompt).toContain("No files recorded");
  });

  test("throws for nonexistent task", () => {
    expect(() => buildResumePrompt("NOPE", db)).toThrow("Task not found");
  });
});
