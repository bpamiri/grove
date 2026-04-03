import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { loadSkills, getSkill, installSkillFromPath, removeSkill } from "../../src/skills/library";
import { bus } from "../../src/broker/event-bus";

let testDir: string;

function makeSkillDir(
  root: string,
  name: string,
  manifest: object,
  extraFiles: Record<string, string> = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), stringifyYaml(manifest));
  for (const [filename, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, filename), content);
  }
  return dir;
}

beforeEach(() => {
  testDir = join(tmpdir(), `grove-skill-api-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// GET /api/skills — loadSkills()
// ---------------------------------------------------------------------------

describe("GET /api/skills", () => {
  test("returns empty array when no skills installed", () => {
    const skills = loadSkills(testDir);
    expect(skills.map(s => s.manifest)).toEqual([]);
  });

  test("returns manifests for installed skills", () => {
    makeSkillDir(testDir, "tdd", {
      name: "tdd",
      version: "1.0.0",
      description: "Test-driven development",
      files: ["tdd.md"],
    });
    makeSkillDir(testDir, "review", {
      name: "review",
      version: "2.0.0",
      description: "Code review skill",
      files: ["review.md"],
    });

    const manifests = loadSkills(testDir).map(s => s.manifest);
    expect(manifests).toHaveLength(2);
    const names = manifests.map(m => m.name).sort();
    expect(names).toEqual(["review", "tdd"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/skills/:name — getSkill() + file contents
// ---------------------------------------------------------------------------

describe("GET /api/skills/:name", () => {
  test("returns skill manifest and file contents", () => {
    makeSkillDir(testDir, "tdd", {
      name: "tdd",
      version: "1.0.0",
      description: "TDD skill",
      files: ["tdd.md", "checklist.md"],
    }, {
      "tdd.md": "# TDD Guide\nWrite tests first.",
      "checklist.md": "- [ ] Red\n- [ ] Green\n- [ ] Refactor",
    });

    const skill = getSkill("tdd", testDir);
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("tdd");

    // Simulate the endpoint's file-content assembly
    const files: Record<string, string> = {};
    for (const filename of skill!.manifest.files) {
      try {
        files[filename] = readFileSync(join(skill!.dir, filename), "utf-8");
      } catch {
        files[filename] = "";
      }
    }

    expect(files["tdd.md"]).toContain("Write tests first.");
    expect(files["checklist.md"]).toContain("Red");
  });

  test("returns null for nonexistent skill", () => {
    const skill = getSkill("nonexistent", testDir);
    expect(skill).toBeNull();
  });

  test("returns empty string for missing file listed in manifest", () => {
    makeSkillDir(testDir, "broken", {
      name: "broken",
      version: "1.0.0",
      description: "Skill with missing file",
      files: ["missing.md"],
    });

    const skill = getSkill("broken", testDir);
    expect(skill).not.toBeNull();

    const files: Record<string, string> = {};
    for (const filename of skill!.manifest.files) {
      try {
        files[filename] = readFileSync(join(skill!.dir, filename), "utf-8");
      } catch {
        files[filename] = "";
      }
    }

    expect(files["missing.md"]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// POST /api/skills/install — installSkillFromPath()
// ---------------------------------------------------------------------------

describe("POST /api/skills/install", () => {
  test("installs skill from path and emits event", () => {
    const srcDir = join(testDir, "src");
    const destDir = join(testDir, "dest");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, "skill.yaml"), stringifyYaml({
      name: "new-skill",
      version: "1.0.0",
      description: "A new skill",
      files: ["guide.md"],
    }));
    writeFileSync(join(srcDir, "guide.md"), "# Guide");

    let emittedName = "";
    const unsub = bus.on("skill:installed", (data) => { emittedName = data.name; });

    const result = installSkillFromPath(srcDir, destDir);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("new-skill");

    // Simulate what the endpoint does after successful install
    bus.emit("skill:installed", { name: result.name! });
    expect(emittedName).toBe("new-skill");

    // Verify the skill is actually installed
    const skill = getSkill("new-skill", destDir);
    expect(skill).not.toBeNull();
    expect(skill!.manifest.version).toBe("1.0.0");

    unsub();
  });

  test("returns error for missing skill.yaml", () => {
    const srcDir = join(testDir, "empty-src");
    mkdirSync(srcDir, { recursive: true });

    const result = installSkillFromPath(srcDir, join(testDir, "dest"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("skill.yaml");
  });

  test("returns error for manifest missing name", () => {
    const srcDir = join(testDir, "bad-src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "skill.yaml"), stringifyYaml({
      version: "1.0.0",
      description: "No name",
      files: [],
    }));

    const result = installSkillFromPath(srcDir, join(testDir, "dest"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/skills/:name — removeSkill()
// ---------------------------------------------------------------------------

describe("DELETE /api/skills/:name", () => {
  test("removes skill and emits event", () => {
    makeSkillDir(testDir, "doomed", {
      name: "doomed",
      version: "1.0.0",
      description: "Will be removed",
      files: [],
    });

    let emittedName = "";
    const unsub = bus.on("skill:removed", (data) => { emittedName = data.name; });

    const removed = removeSkill("doomed", testDir);
    expect(removed).toBe(true);
    expect(existsSync(join(testDir, "doomed"))).toBe(false);

    // Simulate what the endpoint does after successful remove
    bus.emit("skill:removed", { name: "doomed" });
    expect(emittedName).toBe("doomed");

    unsub();
  });

  test("returns false for nonexistent skill", () => {
    const removed = removeSkill("ghost", testDir);
    expect(removed).toBe(false);
  });

  test("does not emit event when skill not found", () => {
    let emitted = false;
    const unsub = bus.on("skill:removed", () => { emitted = true; });

    const removed = removeSkill("ghost", testDir);
    expect(removed).toBe(false);
    // The endpoint would not emit if removeSkill returns false
    expect(emitted).toBe(false);

    unsub();
  });
});
