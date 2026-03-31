import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";
import { join } from "node:path";
import { unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";

const TEST_DB = join(import.meta.dir, "test-seed-session.db");
const TEST_LOG_DIR = join(import.meta.dir, "test-seed-logs");
let db: Database;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = new Database(TEST_DB);
  db.initFromString(SCHEMA_SQL);
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
});

describe("buildSeedPrompt", () => {
  test("includes task ID and title", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Add auth", description: "JWT-based auth" },
      { id: "app", name: "App", path: "/code/app" },
    );
    expect(prompt).toContain("W-001");
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("JWT-based auth");
  });

  test("includes tree info", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Fix bug" },
      { id: "titan", name: "Titan", path: "/code/titan" },
    );
    expect(prompt).toContain("Titan");
    expect(prompt).toContain("/code/titan");
  });

  test("includes seed_complete protocol", async () => {
    const { buildSeedPrompt } = await import("../../src/broker/seed-session");
    const prompt = buildSeedPrompt(
      { id: "W-001", title: "Test" },
      { id: "t", name: "T", path: "/t" },
    );
    expect(prompt).toContain("seed_complete");
    expect(prompt).toContain("seed_html");
  });
});

describe("buildSeedClaudeArgs", () => {
  test("first message includes --session-id and --system-prompt", async () => {
    const { buildSeedClaudeArgs } = await import("../../src/broker/seed-session");
    const args = buildSeedClaudeArgs("Hello", "sess-123", "/code/app", true, "You are a seed...");
    expect(args).toContain("claude");
    expect(args).toContain("-p");
    expect(args).toContain("Hello");
    expect(args).toContain("--session-id");
    expect(args).toContain("sess-123");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  test("follow-up message includes --resume", async () => {
    const { buildSeedClaudeArgs } = await import("../../src/broker/seed-session");
    const args = buildSeedClaudeArgs("Follow up", "sess-123", "/code/app", false, "");
    expect(args).toContain("--resume");
    expect(args).toContain("sess-123");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--system-prompt");
  });
});

describe("parseSeedEvents", () => {
  test("extracts seed_complete event from stream-json text", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: 'Here is the design.\n{"type":"seed_complete","summary":"Auth redesign","spec":"## Spec\\n.."}'
        }]
      }
    });
    const events = parseSeedEvents(line);
    const complete = events.find((e: any) => e.type === "seed_complete");
    expect(complete).toBeDefined();
    expect(complete!.summary).toBe("Auth redesign");
  });

  test("extracts seed_html event from stream-json text", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: '{"type":"seed_html","html":"<div>mockup</div>"}'
        }]
      }
    });
    const events = parseSeedEvents(line);
    const html = events.find((e: any) => e.type === "seed_html");
    expect(html).toBeDefined();
    expect(html!.html).toBe("<div>mockup</div>");
  });

  test("returns empty array for non-assistant events", async () => {
    const { parseSeedEvents } = await import("../../src/broker/seed-session");
    const events = parseSeedEvents(JSON.stringify({ type: "result", cost_usd: 0.01 }));
    expect(events).toEqual([]);
  });
});
