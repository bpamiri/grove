import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { injectSkills } from "../../src/skills/injector";
import { validateSkillInjection } from "../../src/agents/worker";
import type { PipelineStep } from "../../src/shared/types";
import type { InjectionResult } from "../../src/skills/injector";

const TEST_DIR = join(tmpdir(), `grove-worker-skills-test-${Date.now()}`);
const SKILLS_DIR = join(TEST_DIR, "skills");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createSkill(name: string) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), `name: ${name}\nversion: 1.0.0\ndescription: test\nfiles:\n  - skill.md`);
  writeFileSync(join(dir, "skill.md"), `# ${name}`);
}

describe("validateSkillInjection", () => {
  test("throws when skills are missing and step has result_file", () => {
    const injection: InjectionResult = { injected: [], missing: ["merge-handler"] };
    const step: PipelineStep = {
      id: "merge",
      type: "worker",
      skills: ["merge-handler"],
      result_file: ".grove/merge-result.json",
      result_key: "merged",
      on_success: "$done",
      on_failure: "$fail",
    };

    expect(() => validateSkillInjection(injection, step)).toThrow(/merge-handler/);
  });

  test("throws with actionable message mentioning 'grove up'", () => {
    const injection: InjectionResult = { injected: [], missing: ["merge-handler"] };
    const step: PipelineStep = {
      id: "merge",
      type: "worker",
      skills: ["merge-handler"],
      result_file: ".grove/merge-result.json",
      on_success: "$done",
      on_failure: "$fail",
    };

    expect(() => validateSkillInjection(injection, step)).toThrow(/grove up/);
  });

  test("does NOT throw when skills are missing but step has no result_file", () => {
    const injection: InjectionResult = { injected: [], missing: ["optional-skill"] };
    const step: PipelineStep = {
      id: "implement",
      type: "worker",
      skills: ["optional-skill"],
      on_success: "$done",
      on_failure: "$fail",
    };

    // Should not throw — missing skill without result_file is a warning, not fatal
    expect(() => validateSkillInjection(injection, step)).not.toThrow();
  });

  test("does NOT throw when all skills are present", () => {
    const injection: InjectionResult = { injected: ["merge-handler"], missing: [] };
    const step: PipelineStep = {
      id: "merge",
      type: "worker",
      skills: ["merge-handler"],
      result_file: ".grove/merge-result.json",
      on_success: "$done",
      on_failure: "$fail",
    };

    expect(() => validateSkillInjection(injection, step)).not.toThrow();
  });

  test("throws listing all missing skills when multiple are missing", () => {
    const injection: InjectionResult = { injected: [], missing: ["skill-a", "skill-b"] };
    const step: PipelineStep = {
      id: "merge",
      type: "worker",
      skills: ["skill-a", "skill-b"],
      result_file: ".grove/merge-result.json",
      on_success: "$done",
      on_failure: "$fail",
    };

    expect(() => validateSkillInjection(injection, step)).toThrow(/skill-a/);
    expect(() => validateSkillInjection(injection, step)).toThrow(/skill-b/);
  });
});
