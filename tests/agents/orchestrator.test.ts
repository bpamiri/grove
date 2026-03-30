import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-orchestrator.db");
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

describe("buildOrchestratorPrompt", () => {
  test("includes trees in prompt", async () => {
    db.treeUpsert({ id: "titan", name: "Titan", path: "/code/titan", github: "org/titan" });
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("titan");
    expect(prompt).toContain("/code/titan");
    expect(prompt).toContain("org/titan");
  });

  test("includes active tasks in prompt", async () => {
    db.treeUpsert({ id: "t", name: "T", path: "/t" });
    db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "t", "Fix bug", "active"]);
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("W-001");
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("active");
  });

  test("includes grove-event protocol instructions", async () => {
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("<grove-event>");
    expect(prompt).toContain("spawn_worker");
    expect(prompt).toContain("task_update");
  });

  test("includes recent messages when available", async () => {
    db.addMessage("user", "Fix the auth module");
    db.addMessage("orchestrator", "I will create a task for that");
    const { buildOrchestratorPrompt } = await import("../../src/agents/orchestrator");
    const prompt = buildOrchestratorPrompt(db);
    expect(prompt).toContain("Fix the auth module");
    expect(prompt).toContain("I will create a task for that");
  });
});

describe("buildClaudeArgs", () => {
  test("first call uses --session-id and --system-prompt", async () => {
    db.treeUpsert({ id: "t", name: "T", path: "/t" });
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("test message", "uuid-123", db, true);
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-123");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("stream-json");
    expect(args).toContain("-p");
    expect(args).toContain("test message");
  });

  test("resume call uses --resume instead of --session-id", async () => {
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("follow up", "uuid-123", db, false);
    expect(args).toContain("--resume");
    expect(args).toContain("uuid-123");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--system-prompt");
  });

  test("includes --add-dir for each tree", async () => {
    db.treeUpsert({ id: "a", name: "A", path: "/code/a" });
    db.treeUpsert({ id: "b", name: "B", path: "/code/b" });
    const { buildClaudeArgs } = await import("../../src/agents/orchestrator");
    const args = buildClaudeArgs("msg", "uuid", db, true);
    const addDirIndices = args.reduce((acc: number[], arg: string, i: number) => {
      if (arg === "--add-dir") acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices.length).toBe(2);
    expect(args[addDirIndices[0] + 1]).toBe("/code/a");
    expect(args[addDirIndices[1] + 1]).toBe("/code/b");
  });
});
