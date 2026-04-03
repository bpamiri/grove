import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  bootstrapBundledSkills,
  type BootstrapResult,
} from "../../src/skills/library";

let testDir: string;
let bundledDir: string;
let targetDir: string;

function makeSkill(root: string, name: string, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name,
    version: "1.0.0",
    description: `${name} skill`,
    files: Object.keys(files),
  };
  writeFileSync(join(dir, "skill.yaml"), stringifyYaml(manifest));
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dir, filename), content);
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `grove-bootstrap-test-${Date.now()}`);
  bundledDir = join(testDir, "bundled-skills");
  targetDir = join(testDir, "target-skills");
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe("bootstrapBundledSkills", () => {
  // -----------------------------------------------------------------------
  // Filesystem-based bootstrap (development mode)
  // -----------------------------------------------------------------------

  test("installs skills from filesystem bundledDir to targetDir", () => {
    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Merge Handler" });
    makeSkill(bundledDir, "code-review", { "review.md": "# Code Review" });

    const result = bootstrapBundledSkills({ bundledDir, targetDir });

    expect(result.installed).toContain("merge-handler");
    expect(result.installed).toContain("code-review");
    expect(result.installed).toHaveLength(2);
    expect(existsSync(join(targetDir, "merge-handler", "skill.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "code-review", "skill.yaml"))).toBe(true);
  });

  test("skips skills already present in targetDir", () => {
    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Bundled version" });
    // Pre-install a customized version
    makeSkill(targetDir, "merge-handler", { "skill.md": "# User customized" });

    const result = bootstrapBundledSkills({ bundledDir, targetDir });

    expect(result.installed).not.toContain("merge-handler");
    expect(result.skipped).toContain("merge-handler");
    // User's version should be preserved
    const content = readFileSync(join(targetDir, "merge-handler", "skill.md"), "utf-8");
    expect(content).toBe("# User customized");
  });

  test("skips directories without skill.yaml", () => {
    makeSkill(bundledDir, "valid-skill", { "skill.md": "# Valid" });
    mkdirSync(join(bundledDir, "not-a-skill"), { recursive: true });
    writeFileSync(join(bundledDir, "not-a-skill", "README.md"), "no manifest");

    const result = bootstrapBundledSkills({ bundledDir, targetDir });

    expect(result.installed).toEqual(["valid-skill"]);
  });

  test("returns source 'filesystem' when using bundledDir", () => {
    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Merge" });

    const result = bootstrapBundledSkills({ bundledDir, targetDir });

    expect(result.source).toBe("filesystem");
  });

  // -----------------------------------------------------------------------
  // Embedded data fallback (compiled binary)
  // -----------------------------------------------------------------------

  test("falls back to embedded skills when no filesystem dir found", () => {
    const embeddedSkills = {
      "merge-handler": {
        "skill.yaml": stringifyYaml({
          name: "merge-handler",
          version: "1.0.0",
          description: "Merge handler skill",
          files: ["skill.md"],
        }),
        "skill.md": "# Merge Handler\nEmbedded version",
      },
    };

    const result = bootstrapBundledSkills({
      bundledDir: join(testDir, "nonexistent"),
      targetDir,
      embeddedSkills,
    });

    expect(result.source).toBe("embedded");
    expect(result.installed).toContain("merge-handler");
    expect(existsSync(join(targetDir, "merge-handler", "skill.yaml"))).toBe(true);
    const content = readFileSync(join(targetDir, "merge-handler", "skill.md"), "utf-8");
    expect(content).toBe("# Merge Handler\nEmbedded version");
  });

  test("embedded fallback skips skills already present in targetDir", () => {
    makeSkill(targetDir, "merge-handler", { "skill.md": "# User version" });

    const embeddedSkills = {
      "merge-handler": {
        "skill.yaml": stringifyYaml({
          name: "merge-handler",
          version: "1.0.0",
          description: "Merge handler",
          files: ["skill.md"],
        }),
        "skill.md": "# Embedded version",
      },
    };

    const result = bootstrapBundledSkills({
      bundledDir: join(testDir, "nonexistent"),
      targetDir,
      embeddedSkills,
    });

    expect(result.skipped).toContain("merge-handler");
    // User version preserved
    const content = readFileSync(join(targetDir, "merge-handler", "skill.md"), "utf-8");
    expect(content).toBe("# User version");
  });

  // -----------------------------------------------------------------------
  // Warning when no source available
  // -----------------------------------------------------------------------

  test("warns and returns source 'none' when no bundled skills found", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = bootstrapBundledSkills({
      bundledDir: join(testDir, "nonexistent"),
      targetDir,
      embeddedSkills: {},
    });

    expect(result.source).toBe("none");
    expect(result.installed).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("No bundled skills");

    warnSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Summary log
  // -----------------------------------------------------------------------

  test("logs summary of bootstrapped skills count", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Merge" });
    makeSkill(bundledDir, "code-review", { "review.md": "# Review" });

    bootstrapBundledSkills({ bundledDir, targetDir });

    const logCalls = logSpy.mock.calls.map((c) => c[0] as string);
    const summaryLog = logCalls.find((msg) => msg.includes("2") && msg.includes("skill"));
    expect(summaryLog).toBeDefined();

    logSpy.mockRestore();
  });

  test("does not log summary when nothing installed", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    // All skills already present
    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Merge" });
    makeSkill(targetDir, "merge-handler", { "skill.md": "# Already here" });

    bootstrapBundledSkills({ bundledDir, targetDir });

    const logCalls = logSpy.mock.calls.map((c) => c[0] as string);
    const summaryLog = logCalls.find((msg) => msg.includes("Bootstrapped"));
    expect(summaryLog).toBeUndefined();

    logSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Creates target directory if needed
  // -----------------------------------------------------------------------

  test("creates targetDir if it does not exist", () => {
    const freshTarget = join(testDir, "fresh-target");
    makeSkill(bundledDir, "merge-handler", { "skill.md": "# Merge" });

    bootstrapBundledSkills({ bundledDir, targetDir: freshTarget });

    expect(existsSync(join(freshTarget, "merge-handler", "skill.yaml"))).toBe(true);
  });
});
