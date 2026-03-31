import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readPlanContent, parseReviewResult, getPriorReviewFeedback } from "../../src/agents/reviewer";
import { buildReviewOverlay, readReviewFeedback } from "../../src/shared/sandbox";
import type { ReviewOverlayContext } from "../../src/shared/sandbox";
import { createTestDb } from "../fixtures/helpers";
import type { Database } from "../../src/broker/db";

// ---------------------------------------------------------------------------
// readPlanContent — reads plan from .grove/plan.md or falls back to summary
// ---------------------------------------------------------------------------

describe("readPlanContent", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = join(tmpdir(), `grove-test-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(worktreePath, ".grove"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("reads plan from .grove/plan.md", () => {
    writeFileSync(join(worktreePath, ".grove", "plan.md"), "# My Plan\n\nDo stuff.");
    const result = readPlanContent(worktreePath);
    expect(result).toBe("# My Plan\n\nDo stuff.");
  });

  test("falls back to session summary when no plan.md", () => {
    const result = readPlanContent(worktreePath, "Session summary content");
    expect(result).toBe("Session summary content");
  });

  test("prefers plan.md over session summary", () => {
    writeFileSync(join(worktreePath, ".grove", "plan.md"), "Plan from file");
    const result = readPlanContent(worktreePath, "Session summary");
    expect(result).toBe("Plan from file");
  });

  test("returns null when no plan and no summary", () => {
    const result = readPlanContent(worktreePath);
    expect(result).toBeNull();
  });

  test("returns null when plan.md is empty", () => {
    writeFileSync(join(worktreePath, ".grove", "plan.md"), "  ");
    const result = readPlanContent(worktreePath);
    expect(result).toBeNull();
  });

  test("returns null when session summary is empty", () => {
    const result = readPlanContent(worktreePath, "  ");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseReviewResult — reads structured verdict from review-result.json
// ---------------------------------------------------------------------------

describe("parseReviewResult", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = join(tmpdir(), `grove-test-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(worktreePath, ".grove"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("parses approved result", () => {
    writeFileSync(join(worktreePath, ".grove", "review-result.json"),
      JSON.stringify({ approved: true, feedback: "Plan looks solid" }));

    const result = parseReviewResult(worktreePath);
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(true);
    expect(result!.feedback).toBe("Plan looks solid");
  });

  test("parses rejected result", () => {
    writeFileSync(join(worktreePath, ".grove", "review-result.json"),
      JSON.stringify({ approved: false, feedback: "Missing error handling for edge case X" }));

    const result = parseReviewResult(worktreePath);
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(false);
    expect(result!.feedback).toBe("Missing error handling for edge case X");
  });

  test("returns null when file doesn't exist", () => {
    const result = parseReviewResult(worktreePath);
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    writeFileSync(join(worktreePath, ".grove", "review-result.json"), "not json");
    const result = parseReviewResult(worktreePath);
    expect(result).toBeNull();
  });

  test("coerces truthy approved to boolean", () => {
    writeFileSync(join(worktreePath, ".grove", "review-result.json"),
      JSON.stringify({ approved: 1, feedback: "ok" }));

    const result = parseReviewResult(worktreePath);
    expect(result!.approved).toBe(true);
  });

  test("provides default feedback when missing", () => {
    writeFileSync(join(worktreePath, ".grove", "review-result.json"),
      JSON.stringify({ approved: false }));

    const result = parseReviewResult(worktreePath);
    expect(result!.feedback).toBe("No feedback provided");
  });
});

// ---------------------------------------------------------------------------
// getPriorReviewFeedback — reads rejection history from events table
// ---------------------------------------------------------------------------

describe("getPriorReviewFeedback", () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    cleanup = t.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  test("returns empty array when no rejections", () => {
    const result = getPriorReviewFeedback(db, "T-001");
    expect(result).toEqual([]);
  });

  test("returns prior rejection feedback in order", () => {
    db.addEvent("T-001", null, "review_rejected", "Missing tests");
    db.addEvent("T-001", null, "review_rejected", "API design flaw");

    const result = getPriorReviewFeedback(db, "T-001");
    expect(result).toEqual(["Missing tests", "API design flaw"]);
  });

  test("ignores events from other tasks", () => {
    db.addEvent("T-001", null, "review_rejected", "Task 1 feedback");
    db.addEvent("T-002", null, "review_rejected", "Task 2 feedback");

    const result = getPriorReviewFeedback(db, "T-001");
    expect(result).toEqual(["Task 1 feedback"]);
  });

  test("ignores non-rejection events", () => {
    db.addEvent("T-001", null, "review_started", "Review started");
    db.addEvent("T-001", null, "review_rejected", "Real feedback");
    db.addEvent("T-001", null, "review_approved", "Approved");

    const result = getPriorReviewFeedback(db, "T-001");
    expect(result).toEqual(["Real feedback"]);
  });
});

// ---------------------------------------------------------------------------
// readReviewFeedback — reads feedback file from worktree
// ---------------------------------------------------------------------------

describe("readReviewFeedback", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = join(tmpdir(), `grove-test-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(worktreePath, ".grove"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("reads feedback when file exists", () => {
    writeFileSync(join(worktreePath, ".grove", "review-feedback.md"), "Fix the tests");
    const result = readReviewFeedback(worktreePath);
    expect(result).toBe("Fix the tests");
  });

  test("returns null when file doesn't exist", () => {
    const result = readReviewFeedback(worktreePath);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildReviewOverlay — CLAUDE.md content for reviewer sessions
// ---------------------------------------------------------------------------

describe("buildReviewOverlay", () => {
  const baseCtx: ReviewOverlayContext = {
    taskId: "T-001",
    title: "Add feature X",
    treePath: "/tmp/fake-tree",
    planContent: "# Plan\n\n1. Add routes\n2. Write tests",
  };

  test("includes role description", () => {
    const overlay = buildReviewOverlay(baseCtx);
    expect(overlay).toContain("adversarial reviewer");
    expect(overlay).toContain("CANNOT modify any code");
  });

  test("includes plan content in markdown code block", () => {
    const overlay = buildReviewOverlay(baseCtx);
    expect(overlay).toContain("```markdown");
    expect(overlay).toContain("# Plan");
    expect(overlay).toContain("1. Add routes");
  });

  test("includes step prompt as review criteria", () => {
    const overlay = buildReviewOverlay({
      ...baseCtx,
      stepPrompt: "Check for backwards compatibility issues",
    });
    expect(overlay).toContain("Review Criteria");
    expect(overlay).toContain("backwards compatibility");
  });

  test("includes output instructions for review-result.json", () => {
    const overlay = buildReviewOverlay(baseCtx);
    expect(overlay).toContain("review-result.json");
    expect(overlay).toContain('"approved"');
  });

  test("includes task description when provided", () => {
    const overlay = buildReviewOverlay({
      ...baseCtx,
      description: "We need to add feature X to the API",
    });
    expect(overlay).toContain("Task Description");
    expect(overlay).toContain("feature X to the API");
  });

  test("includes prior feedback history", () => {
    const overlay = buildReviewOverlay({
      ...baseCtx,
      priorFeedback: ["Missing error handling", "API naming inconsistent"],
    });
    expect(overlay).toContain("Prior Review History");
    expect(overlay).toContain("Round 1 feedback");
    expect(overlay).toContain("Missing error handling");
    expect(overlay).toContain("Round 2 feedback");
    expect(overlay).toContain("API naming inconsistent");
  });

  test("omits prior feedback section when empty", () => {
    const overlay = buildReviewOverlay(baseCtx);
    expect(overlay).not.toContain("Prior Review History");
  });

  test("includes explicit approval requirement", () => {
    const overlay = buildReviewOverlay(baseCtx);
    expect(overlay).toContain("explicitly approve");
    expect(overlay).toContain("silence or lack of objection is NOT approval");
  });
});
