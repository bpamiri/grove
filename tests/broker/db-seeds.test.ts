import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { Database } from "../../src/broker/db";
import { SCHEMA_SQL } from "../../src/broker/schema-sql";

const TEST_DIR = join(import.meta.dir, "test-seeds");
const DB_PATH = join(TEST_DIR, "test.db");

let db: Database;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
  db = new Database(DB_PATH);
  db.initFromString(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

describe("seed operations", () => {
  test("seedCreate creates a seed with active status", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    const seed = db.seedGet("W-001");
    expect(seed).not.toBeNull();
    expect(seed!.task_id).toBe("W-001");
    expect(seed!.status).toBe("active");
    expect(seed!.summary).toBeNull();
    expect(seed!.spec).toBeNull();
  });

  test("seedGet returns null for non-existent seed", () => {
    expect(db.seedGet("W-999")).toBeNull();
  });

  test("seedComplete sets summary, spec, and status", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedComplete("W-001", "JWT auth design", "# Auth Spec\nUse JWT...");
    const seed = db.seedGet("W-001");
    expect(seed!.status).toBe("completed");
    expect(seed!.summary).toBe("JWT auth design");
    expect(seed!.spec).toBe("# Auth Spec\nUse JWT...");
    expect(seed!.completed_at).not.toBeNull();
  });

  test("seedUpdateConversation stores JSON", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    const msgs = [{ source: "ai", content: "Hello" }, { source: "user", content: "Hi" }];
    db.seedUpdateConversation("W-001", msgs);
    const seed = db.seedGet("W-001");
    expect(JSON.parse(seed!.conversation!)).toEqual(msgs);
  });

  test("seedDiscard sets status to discarded", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedDiscard("W-001");
    // seedGet filters out discarded rows, so result should be null
    const seed = db.seedGet("W-001");
    expect(seed).toBeNull();
  });

  test("seedDelete removes the seed", () => {
    db.run("INSERT INTO tasks (id, title, status) VALUES ('W-001', 'Test', 'draft')");
    db.seedCreate("W-001");
    db.seedDelete("W-001");
    expect(db.seedGet("W-001")).toBeNull();
  });
});
