import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

// We test the guard logic functions directly rather than spawning a process.
// The run() function is the CLI entry point — we test the internal helpers.
import {
  checkBashDanger,
  checkEditBoundary,
  checkReviewWrite,
  checkReviewBash,
} from "../../src/cli/commands/_guard";

const WORKTREE = join(tmpdir(), "grove-test-guard-wt");

beforeEach(() => {
  mkdirSync(WORKTREE, { recursive: true });
});

afterEach(() => {
  rmSync(WORKTREE, { recursive: true, force: true });
});

describe("checkBashDanger", () => {
  test("blocks git push", () => {
    const result = checkBashDanger({ command: "git push origin main" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("git push");
  });

  test("blocks git reset --hard", () => {
    const result = checkBashDanger({ command: "git reset --hard HEAD~1" });
    expect(result.blocked).toBe(true);
  });

  test("blocks rm -rf /", () => {
    const result = checkBashDanger({ command: "rm -rf /" });
    expect(result.blocked).toBe(true);
  });

  test("blocks sudo", () => {
    const result = checkBashDanger({ command: "sudo apt install foo" });
    expect(result.blocked).toBe(true);
  });

  test("case insensitive", () => {
    const result = checkBashDanger({ command: "Git Push origin main" });
    expect(result.blocked).toBe(true);
  });

  test("allows git log", () => {
    const result = checkBashDanger({ command: "git log --oneline" });
    expect(result.blocked).toBe(false);
  });

  test("allows bun test", () => {
    const result = checkBashDanger({ command: "bun test tests/" });
    expect(result.blocked).toBe(false);
  });

  test("allows empty input", () => {
    const result = checkBashDanger({});
    expect(result.blocked).toBe(false);
  });
});

describe("checkEditBoundary", () => {
  test("allows path inside worktree", () => {
    const filePath = join(WORKTREE, "src", "index.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("allows path in temp dir", () => {
    const filePath = join(tmpdir(), "grove-scratch", "file.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks path outside worktree", () => {
    const result = checkEditBoundary({ file_path: "/etc/passwd" }, WORKTREE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("outside worktree");
  });

  test("handles path with spaces", () => {
    const filePath = join(WORKTREE, "my folder", "file.ts");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks relative path resolving outside worktree", () => {
    const filePath = join(WORKTREE, "..", "..", "etc", "passwd");
    const result = checkEditBoundary({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(true);
  });

  test("allows when file_path is missing", () => {
    const result = checkEditBoundary({}, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});

describe("checkReviewWrite", () => {
  test("allows .grove/review-result.json", () => {
    const filePath = join(WORKTREE, ".grove", "review-result.json");
    const result = checkReviewWrite({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(false);
  });

  test("blocks any other path", () => {
    const filePath = join(WORKTREE, "src", "index.ts");
    const result = checkReviewWrite({ file_path: filePath }, WORKTREE);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("review-result.json");
  });

  test("allows when file_path is missing", () => {
    const result = checkReviewWrite({}, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});

describe("checkReviewBash", () => {
  test("blocks git commit", () => {
    const result = checkReviewBash({ command: "git commit -m 'test'" });
    expect(result.blocked).toBe(true);
  });

  test("blocks git add", () => {
    const result = checkReviewBash({ command: "git add ." });
    expect(result.blocked).toBe(true);
  });

  test("blocks git checkout", () => {
    const result = checkReviewBash({ command: "git checkout main" });
    expect(result.blocked).toBe(true);
  });

  test("blocks git push", () => {
    const result = checkReviewBash({ command: "git push origin main" });
    expect(result.blocked).toBe(true);
  });

  test("allows git log", () => {
    const result = checkReviewBash({ command: "git log --oneline" });
    expect(result.blocked).toBe(false);
  });

  test("allows git diff", () => {
    const result = checkReviewBash({ command: "git diff HEAD" });
    expect(result.blocked).toBe(false);
  });
});

describe("missing/malformed input", () => {
  test("checkBashDanger with malformed JSON gracefully returns not blocked", () => {
    const result = checkBashDanger(null as any);
    expect(result.blocked).toBe(false);
  });

  test("checkEditBoundary with malformed JSON gracefully returns not blocked", () => {
    const result = checkEditBoundary(null as any, WORKTREE);
    expect(result.blocked).toBe(false);
  });
});
