// Tests for sandbox: guard hooks, overlay generation, and deployment
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/core/db";
import {
  buildGuardHooks,
  buildOverlay,
  deploySandbox,
  buildTriggerPrompt,
  buildResumeTriggerPrompt,
} from "../../src/lib/sandbox";

const schemaPath = join(import.meta.dir, "../../schema.sql");

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-sandbox-test-"));
  db = new Database(join(tempDir, "grove.db"));
  db.init(schemaPath);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildGuardHooks
// ---------------------------------------------------------------------------

describe("buildGuardHooks", () => {
  test("returns valid SandboxConfig structure", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    expect(config).toHaveProperty("hooks");
    expect(config.hooks).toHaveProperty("PreToolUse");
    expect(Array.isArray(config.hooks.PreToolUse)).toBe(true);
  });

  test("has hooks for Bash, Write, and Edit matchers", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const matchers = config.hooks.PreToolUse.map((h) => h.matcher);
    expect(matchers).toContain("Bash");
    expect(matchers).toContain("Write");
    expect(matchers).toContain("Edit");
  });

  test("every hook entry has type command", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    for (const entry of config.hooks.PreToolUse) {
      for (const hook of entry.hooks) {
        expect(hook.type).toBe("command");
        expect(typeof hook.command).toBe("string");
      }
    }
  });

  test("every hook command starts with env-var guard", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    for (const entry of config.hooks.PreToolUse) {
      for (const hook of entry.hooks) {
        expect(hook.command).toContain('[ -z "$GROVE_TASK_ID" ] && exit 0');
      }
    }
  });

  test("danger guard blocks git push", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const bashHooks = config.hooks.PreToolUse.filter((h) => h.matcher === "Bash");
    const allCommands = bashHooks.flatMap((h) => h.hooks.map((hh) => hh.command)).join(" ");
    expect(allCommands).toContain("git push");
    expect(allCommands).toContain("BLOCKED");
  });

  test("danger guard blocks git reset --hard", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const allCommands = config.hooks.PreToolUse
      .filter((h) => h.matcher === "Bash")
      .flatMap((h) => h.hooks.map((hh) => hh.command))
      .join(" ");
    expect(allCommands).toContain("git reset --hard");
  });

  test("danger guard blocks sudo", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const allCommands = config.hooks.PreToolUse
      .filter((h) => h.matcher === "Bash")
      .flatMap((h) => h.hooks.map((hh) => hh.command))
      .join(" ");
    expect(allCommands).toContain("sudo");
  });

  test("safe whitelist includes git merge and git cherry-pick", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const bashHooks = config.hooks.PreToolUse.filter((h) => h.matcher === "Bash");
    const allCommands = bashHooks.flatMap((h) => h.hooks.map((hh) => hh.command)).join(" ");
    expect(allCommands).toContain("git merge");
    expect(allCommands).toContain("git cherry-pick");
  });

  test("Write and Edit hooks check file_path", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const writeHooks = config.hooks.PreToolUse.filter((h) => h.matcher === "Write");
    const editHooks = config.hooks.PreToolUse.filter((h) => h.matcher === "Edit");

    expect(writeHooks.length).toBeGreaterThan(0);
    expect(editHooks.length).toBeGreaterThan(0);

    for (const entry of [...writeHooks, ...editHooks]) {
      const cmd = entry.hooks[0].command;
      expect(cmd).toContain("file_path");
      expect(cmd).toContain("GROVE_WORKTREE_PATH");
    }
  });

  test("path boundary allows /tmp and /dev exceptions", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const writeCmd = config.hooks.PreToolUse
      .filter((h) => h.matcher === "Write")
      .flatMap((h) => h.hooks.map((hh) => hh.command))
      .join(" ");

    expect(writeCmd).toContain("/tmp/*");
    expect(writeCmd).toContain("/dev/*");
  });

  test("produces valid JSON when serialized", () => {
    const config = buildGuardHooks("T-001", "/tmp/worktree");
    const json = JSON.stringify(config, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildOverlay
// ---------------------------------------------------------------------------

describe("buildOverlay", () => {
  test("includes task ID and title", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix the login page", "ready"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("T-001");
    expect(overlay).toContain("Fix the login page");
  });

  test("includes description when present", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, description, status) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "The login form crashes on empty submit", "ready"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("login form crashes");
  });

  test("includes strategy instructions", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, strategy) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready", "solo"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("sole worker");
  });

  test("includes team strategy with scope", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, strategy, strategy_config) VALUES (?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Refactor", "ready", "team", "auth module only"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("one worker in a team");
    expect(overlay).toContain("auth module only");
  });

  test("includes branch and commit format", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, branch) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready", "grove/T-001-fix-bug"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("grove/T-001-fix-bug");
    expect(overlay).toContain("grove(T-001):");
  });

  test("includes session summary when present (resume context)", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, session_summary) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "Fixed half the routes"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("Previous Session");
    expect(overlay).toContain("Fixed half the routes");
  });

  test("includes files_modified and next_steps when present", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, files_modified, next_steps) VALUES (?, ?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "paused", "src/router.ts", "Handle edge cases"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("src/router.ts");
    expect(overlay).toContain("Handle edge cases");
  });

  test("includes source info for github_issue", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, source_ref, title, status) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "github_issue", "cfwheels/wheels#42", "Fix issue", "ready"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("GitHub Issue: cfwheels/wheels#42");
  });

  test("includes CLAUDE.md content when repo has it", () => {
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

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("Use TypeScript");
  });

  test("includes session summary instructions", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("session-summary.md");
    expect(overlay).toContain("Session Summary Instructions");
  });

  test("includes no-push guideline", () => {
    db.exec(
      "INSERT INTO tasks (id, source_type, title, status, branch) VALUES (?, ?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready", "grove/T-001-fix-bug"],
    );

    const overlay = buildOverlay("T-001", db);
    expect(overlay).toContain("Do NOT push to remote");
  });

  test("throws for nonexistent task", () => {
    expect(() => buildOverlay("NOPE", db)).toThrow("Task not found");
  });
});

// ---------------------------------------------------------------------------
// deploySandbox
// ---------------------------------------------------------------------------

describe("deploySandbox", () => {
  test("creates .claude directory", () => {
    const wtPath = join(tempDir, "worktree");
    mkdirSync(wtPath, { recursive: true });

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    deploySandbox(wtPath, "T-001", db);

    expect(existsSync(join(wtPath, ".claude"))).toBe(true);
  });

  test("writes settings.local.json with guard hooks", () => {
    const wtPath = join(tempDir, "worktree");
    mkdirSync(wtPath, { recursive: true });

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    deploySandbox(wtPath, "T-001", db);

    const settingsPath = join(wtPath, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings).toHaveProperty("hooks");
    expect(settings.hooks).toHaveProperty("PreToolUse");
    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
  });

  test("writes CLAUDE.md with task overlay", () => {
    const wtPath = join(tempDir, "worktree");
    mkdirSync(wtPath, { recursive: true });

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix the login page", "ready"],
    );

    deploySandbox(wtPath, "T-001", db);

    const overlayPath = join(wtPath, ".claude", "CLAUDE.md");
    expect(existsSync(overlayPath)).toBe(true);

    const content = readFileSync(overlayPath, "utf-8");
    expect(content).toContain("T-001");
    expect(content).toContain("Fix the login page");
  });

  test("preserves existing settings.local.json content", () => {
    const wtPath = join(tempDir, "worktree");
    const claudeDir = join(wtPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Write existing settings with permissions
    const existing = {
      permissions: {
        allow: ["Read", "Glob"],
      },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo existing" }] },
        ],
      },
    };
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(existing));

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    deploySandbox(wtPath, "T-001", db);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));

    // Should preserve permissions
    expect(settings.permissions).toEqual({ allow: ["Read", "Glob"] });

    // Should merge hooks (existing + sandbox hooks)
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(1);
    // First entry should be the existing one
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo existing");
  });

  test("overwrites invalid existing settings.local.json", () => {
    const wtPath = join(tempDir, "worktree");
    const claudeDir = join(wtPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(join(claudeDir, "settings.local.json"), "not valid json{{{");

    db.exec(
      "INSERT INTO tasks (id, source_type, title, status) VALUES (?, ?, ?, ?)",
      ["T-001", "manual", "Fix bug", "ready"],
    );

    deploySandbox(wtPath, "T-001", db);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings).toHaveProperty("hooks");
    expect(settings.hooks).toHaveProperty("PreToolUse");
  });
});

// ---------------------------------------------------------------------------
// Trigger prompts
// ---------------------------------------------------------------------------

describe("buildTriggerPrompt", () => {
  test("includes task ID", () => {
    const prompt = buildTriggerPrompt("T-001");
    expect(prompt).toContain("T-001");
  });

  test("references CLAUDE.md", () => {
    const prompt = buildTriggerPrompt("T-001");
    expect(prompt).toContain("CLAUDE.md");
  });

  test("mentions session summary", () => {
    const prompt = buildTriggerPrompt("T-001");
    expect(prompt).toContain("session summary");
  });

  test("is reasonably short (under 300 chars)", () => {
    const prompt = buildTriggerPrompt("T-001");
    expect(prompt.length).toBeLessThan(300);
  });
});

describe("buildResumeTriggerPrompt", () => {
  test("includes task ID", () => {
    const prompt = buildResumeTriggerPrompt("T-001");
    expect(prompt).toContain("T-001");
  });

  test("references CLAUDE.md", () => {
    const prompt = buildResumeTriggerPrompt("T-001");
    expect(prompt).toContain("CLAUDE.md");
  });

  test("mentions resume/continue context", () => {
    const prompt = buildResumeTriggerPrompt("T-001");
    expect(prompt).toContain("Resume");
    expect(prompt).toContain("Continue");
  });

  test("is reasonably short (under 300 chars)", () => {
    const prompt = buildResumeTriggerPrompt("T-001");
    expect(prompt.length).toBeLessThan(300);
  });
});
