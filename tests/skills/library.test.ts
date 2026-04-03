import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { loadSkills, getSkill, installSkillFromPath, removeSkill } from "../../src/skills/library";

let testDir: string;

function makeSkillDir(root: string, name: string, manifest: object, extraFiles: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), stringifyYaml(manifest));
  for (const [filename, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, filename), content);
  }
  return dir;
}

beforeEach(() => {
  testDir = join(tmpdir(), `grove-skills-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("loadSkills", () => {
  test("returns empty array for empty directory", () => {
    const skills = loadSkills(testDir);
    expect(skills).toEqual([]);
  });

  test("returns empty array when directory does not exist", () => {
    const skills = loadSkills(join(testDir, "nonexistent"));
    expect(skills).toEqual([]);
  });

  test("loads skills from directory", () => {
    makeSkillDir(testDir, "my-skill", {
      name: "my-skill",
      version: "1.0.0",
      description: "A test skill",
      files: ["skill.md"],
    });
    makeSkillDir(testDir, "another-skill", {
      name: "another-skill",
      version: "0.1.0",
      description: "Another test skill",
      files: [],
    });

    const skills = loadSkills(testDir);
    expect(skills).toHaveLength(2);
    const names = skills.map(s => s.manifest.name).sort();
    expect(names).toEqual(["another-skill", "my-skill"]);
  });

  test("skips directories without skill.yaml", () => {
    // Create a valid skill
    makeSkillDir(testDir, "valid-skill", {
      name: "valid-skill",
      version: "1.0.0",
      description: "Valid",
      files: [],
    });
    // Create a directory without skill.yaml
    mkdirSync(join(testDir, "not-a-skill"), { recursive: true });
    writeFileSync(join(testDir, "not-a-skill", "README.md"), "just a folder");

    const skills = loadSkills(testDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.name).toBe("valid-skill");
  });

  test("skips non-directory entries", () => {
    makeSkillDir(testDir, "real-skill", {
      name: "real-skill",
      version: "1.0.0",
      description: "Real",
      files: [],
    });
    // Create a file at the root level
    writeFileSync(join(testDir, "some-file.txt"), "not a skill");

    const skills = loadSkills(testDir);
    expect(skills).toHaveLength(1);
  });

  test("returns dir path for each skill", () => {
    makeSkillDir(testDir, "my-skill", {
      name: "my-skill",
      version: "1.0.0",
      description: "Test",
      files: [],
    });

    const skills = loadSkills(testDir);
    expect(skills[0].dir).toBe(join(testDir, "my-skill"));
  });
});

describe("getSkill", () => {
  test("returns skill by name", () => {
    makeSkillDir(testDir, "tdd", {
      name: "tdd",
      version: "1.0.0",
      description: "Test-driven development skill",
      files: ["tdd.md"],
    });

    const skill = getSkill("tdd", testDir);
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("tdd");
    expect(skill!.manifest.version).toBe("1.0.0");
  });

  test("returns null for missing skill", () => {
    const skill = getSkill("nonexistent", testDir);
    expect(skill).toBeNull();
  });

  test("returns null when skill dir has no skill.yaml", () => {
    mkdirSync(join(testDir, "broken-skill"), { recursive: true });
    writeFileSync(join(testDir, "broken-skill", "README.md"), "oops");

    const skill = getSkill("broken-skill", testDir);
    expect(skill).toBeNull();
  });

  test("returns correct dir path", () => {
    makeSkillDir(testDir, "my-skill", {
      name: "my-skill",
      version: "1.0.0",
      description: "Test",
      files: [],
    });

    const skill = getSkill("my-skill", testDir);
    expect(skill!.dir).toBe(join(testDir, "my-skill"));
  });
});

describe("installSkillFromPath", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = join(testDir, "src");
    destDir = join(testDir, "dest");
    mkdirSync(srcDir, { recursive: true });
  });

  test("copies skill into library", () => {
    const manifest = {
      name: "new-skill",
      version: "1.0.0",
      description: "A brand new skill",
      files: ["guide.md"],
    };
    writeFileSync(join(srcDir, "skill.yaml"), stringifyYaml(manifest));
    writeFileSync(join(srcDir, "guide.md"), "# Guide");

    const result = installSkillFromPath(srcDir, destDir);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("new-skill");

    // Verify files were copied
    expect(existsSync(join(destDir, "new-skill", "skill.yaml"))).toBe(true);
    expect(existsSync(join(destDir, "new-skill", "guide.md"))).toBe(true);
  });

  test("fails if no skill.yaml", () => {
    writeFileSync(join(srcDir, "README.md"), "no manifest here");

    const result = installSkillFromPath(srcDir, destDir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("skill.yaml");
  });

  test("creates destination directory if needed", () => {
    const manifest = {
      name: "auto-dir-skill",
      version: "1.0.0",
      description: "Tests auto dir creation",
      files: [],
    };
    writeFileSync(join(srcDir, "skill.yaml"), stringifyYaml(manifest));

    const newDest = join(testDir, "new-library");
    expect(existsSync(newDest)).toBe(false);

    const result = installSkillFromPath(srcDir, newDest);
    expect(result.ok).toBe(true);
    expect(existsSync(newDest)).toBe(true);

    try { rmSync(newDest, { recursive: true, force: true }); } catch {}
  });

  test("overwrites existing skill", () => {
    const manifest = {
      name: "existing-skill",
      version: "1.0.0",
      description: "Original",
      files: [],
    };
    makeSkillDir(destDir, "existing-skill", manifest);

    const updatedManifest = { ...manifest, version: "2.0.0", description: "Updated" };
    writeFileSync(join(srcDir, "skill.yaml"), stringifyYaml(updatedManifest));

    const result = installSkillFromPath(srcDir, destDir);
    expect(result.ok).toBe(true);

    const installed = getSkill("existing-skill", destDir);
    expect(installed!.manifest.version).toBe("2.0.0");
  });
});

describe("removeSkill", () => {
  test("removes installed skill", () => {
    makeSkillDir(testDir, "to-remove", {
      name: "to-remove",
      version: "1.0.0",
      description: "Will be removed",
      files: [],
    });

    expect(existsSync(join(testDir, "to-remove"))).toBe(true);

    const removed = removeSkill("to-remove", testDir);
    expect(removed).toBe(true);
    expect(existsSync(join(testDir, "to-remove"))).toBe(false);
  });

  test("returns false for missing skill", () => {
    const removed = removeSkill("does-not-exist", testDir);
    expect(removed).toBe(false);
  });

  test("does not affect other skills", () => {
    makeSkillDir(testDir, "skill-a", {
      name: "skill-a",
      version: "1.0.0",
      description: "Stays",
      files: [],
    });
    makeSkillDir(testDir, "skill-b", {
      name: "skill-b",
      version: "1.0.0",
      description: "Gets removed",
      files: [],
    });

    removeSkill("skill-b", testDir);

    expect(existsSync(join(testDir, "skill-a"))).toBe(true);
    expect(existsSync(join(testDir, "skill-b"))).toBe(false);
  });
});
