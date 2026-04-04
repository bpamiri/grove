import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

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

describe("buildEventReferenceSection", () => {
  test("documents spawn_worker and task_update", async () => {
    const { buildEventReferenceSection } = await import("../../src/agents/orchestrator");
    const section = buildEventReferenceSection();
    expect(section).toContain("spawn_worker");
    expect(section).toContain("task_update");
    expect(section).toContain("path_name");
    expect(section).toContain("depends_on");
  });

  test("includes example grove-event tags", async () => {
    const { buildEventReferenceSection } = await import("../../src/agents/orchestrator");
    const section = buildEventReferenceSection();
    expect(section).toContain("<grove-event>");
    expect(section).toContain("</grove-event>");
  });
});

describe("buildPipelinePathsSection", () => {
  test("includes default paths with descriptions", async () => {
    const { buildPipelinePathsSection } = await import("../../src/agents/orchestrator");
    const section = buildPipelinePathsSection();
    expect(section).toContain("development");
    expect(section).toContain("research");
    expect(section).toContain("adversarial");
    expect(section).toContain("Standard dev workflow");
  });

  test("shows step flow for each path", async () => {
    const { buildPipelinePathsSection } = await import("../../src/agents/orchestrator");
    const section = buildPipelinePathsSection();
    expect(section).toContain("implement");
    expect(section).toContain("review");
    expect(section).toContain("merge");
  });
});

describe("buildSkillCatalogSection", () => {
  const TEST_SKILLS_DIR = join(import.meta.dir, "test-skills");

  afterEach(() => {
    if (existsSync(TEST_SKILLS_DIR)) rmSync(TEST_SKILLS_DIR, { recursive: true, force: true });
  });

  test("returns empty when no skills installed", async () => {
    process.env.GROVE_SKILLS_DIR = join(import.meta.dir, "nonexistent-skills-dir");
    // Re-import to pick up env change
    const mod = await import("../../src/agents/orchestrator");
    const section = mod.buildSkillCatalogSection();
    expect(section).toBe("");
    delete process.env.GROVE_SKILLS_DIR;
  });

  test("lists skills with descriptions", async () => {
    mkdirSync(join(TEST_SKILLS_DIR, "my-skill"), { recursive: true });
    writeFileSync(join(TEST_SKILLS_DIR, "my-skill", "skill.yaml"), `name: my-skill\nversion: "1.0"\ndescription: A test skill\nfiles: []\nsuggested_steps: [review]\n`);
    process.env.GROVE_SKILLS_DIR = TEST_SKILLS_DIR;
    const mod = await import("../../src/agents/orchestrator");
    const section = mod.buildSkillCatalogSection();
    expect(section).toContain("my-skill");
    expect(section).toContain("A test skill");
    expect(section).toContain("review");
    delete process.env.GROVE_SKILLS_DIR;
  });
});

describe("buildBudgetSection", () => {
  test("shows cost and limits", async () => {
    const { buildBudgetSection } = await import("../../src/agents/orchestrator");
    const section = buildBudgetSection(db);
    expect(section).toContain("$0.00");
    expect(section).toContain("$25.00/day");
    expect(section).toContain("$100.00/week");
    expect(section).toContain("$5.00");
    expect(section).toContain("80%");
  });
});

describe("buildCliReferenceSection", () => {
  test("includes core commands", async () => {
    const { buildCliReferenceSection } = await import("../../src/agents/orchestrator");
    const section = buildCliReferenceSection();
    expect(section).toContain("init");
    expect(section).toContain("up");
    expect(section).toContain("down");
    expect(section).toContain("chat");
    expect(section).toContain("tasks");
    expect(section).toContain("skills");
    expect(section).toContain("config");
    expect(section).toContain("insights");
    expect(section).toContain("paths");
    expect(section).toContain("plugins");
    expect(section).toContain("upgrade");
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
