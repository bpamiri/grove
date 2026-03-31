import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createCheckpoint, loadCheckpoint, commitWip, type Checkpoint } from "../../src/agents/checkpoint";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

const TEST_DIR = join(import.meta.dir, "test-checkpoint-repo");

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".grove"), { recursive: true });
  // Init git repo
  Bun.spawnSync(["git", "init"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_DIR });
  writeFileSync(join(TEST_DIR, "initial.txt"), "init");
  Bun.spawnSync(["git", "add", "-A"], { cwd: TEST_DIR });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: TEST_DIR });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("commitWip", () => {
  test("commits uncommitted changes", () => {
    writeFileSync(join(TEST_DIR, "new-file.ts"), "export const x = 1;");
    const sha = commitWip(TEST_DIR, "W-001");
    expect(sha).not.toBeNull();
    expect(sha!.length).toBeGreaterThan(6);
  });

  test("returns null when no changes", () => {
    const sha = commitWip(TEST_DIR, "W-001");
    expect(sha).toBeNull();
  });
});

describe("createCheckpoint", () => {
  test("creates checkpoint JSON in .grove/", () => {
    writeFileSync(join(TEST_DIR, "work.ts"), "export const y = 2;");
    const checkpoint = createCheckpoint(TEST_DIR, {
      taskId: "W-001",
      stepId: "implement",
      stepIndex: 1,
      sessionSummary: "Started implementing auth",
      costSoFar: 0.50,
      tokensSoFar: 5000,
    });
    expect(checkpoint.taskId).toBe("W-001");
    expect(checkpoint.commitSha).not.toBeNull();
    expect(checkpoint.filesModified.length).toBeGreaterThan(0);

    // Verify file was written
    const filePath = join(TEST_DIR, ".grove", "checkpoint.json");
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("loadCheckpoint", () => {
  test("loads checkpoint from .grove/checkpoint.json", () => {
    const checkpoint: Checkpoint = {
      taskId: "W-001",
      stepId: "implement",
      stepIndex: 1,
      timestamp: new Date().toISOString(),
      commitSha: "abc123",
      filesModified: ["src/a.ts"],
      sessionSummary: "Did work",
      nextAction: "Continue",
      costSoFar: 1.0,
      tokensSoFar: 10000,
    };
    writeFileSync(join(TEST_DIR, ".grove", "checkpoint.json"), JSON.stringify(checkpoint));

    const loaded = loadCheckpoint(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("W-001");
    expect(loaded!.sessionSummary).toBe("Did work");
  });

  test("returns null when no checkpoint exists", () => {
    expect(loadCheckpoint(TEST_DIR)).toBeNull();
  });
});
