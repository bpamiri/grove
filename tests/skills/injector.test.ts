import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { injectSkills } from "../../src/skills/injector";

const TEST_DIR = join(import.meta.dir, "test-inject");
const SKILLS_DIR = join(TEST_DIR, "skills");
const WORKTREE_DIR = join(TEST_DIR, "worktree");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(WORKTREE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createSkill(name: string, content: string) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), `name: ${name}\nversion: 1.0.0\ndescription: test\nfiles:\n  - skill.md`);
  writeFileSync(join(dir, "skill.md"), content);
}

describe("injectSkills", () => {
  test("copies skill files into worktree .claude/skills/", () => {
    createSkill("code-review", "# Code Review\nReview the code.");
    const result = injectSkills(["code-review"], WORKTREE_DIR, SKILLS_DIR);
    expect(result.injected).toEqual(["code-review"]);
    expect(result.missing).toEqual([]);
    const injectedPath = join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md");
    expect(existsSync(injectedPath)).toBe(true);
    expect(readFileSync(injectedPath, "utf-8")).toContain("Code Review");
  });

  test("injects multiple skills", () => {
    createSkill("code-review", "# Review");
    createSkill("security-audit", "# Security");
    const result = injectSkills(["code-review", "security-audit"], WORKTREE_DIR, SKILLS_DIR);
    expect(result.injected).toEqual(["code-review", "security-audit"]);
    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md"))).toBe(true);
    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "security-audit", "skill.md"))).toBe(true);
  });

  test("reports missing skills without failing", () => {
    createSkill("code-review", "# Review");
    const result = injectSkills(["code-review", "nonexistent"], WORKTREE_DIR, SKILLS_DIR);
    expect(result.injected).toEqual(["code-review"]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  test("handles empty skills array", () => {
    const result = injectSkills([], WORKTREE_DIR, SKILLS_DIR);
    expect(result.injected).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
