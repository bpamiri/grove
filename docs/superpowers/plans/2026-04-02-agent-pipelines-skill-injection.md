# Agent Pipelines with Skill Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace code-based pipeline steps (gates, merge, review) with agent-based worker steps that use injectable skills from a skill library.

**Architecture:** All pipeline work steps become `worker` type (Claude Code sessions). Skills are standard Claude Code `.md` files installed in `~/.grove/skills/` and copied into worktrees before agent spawn. The step engine simplifies from 5 step types to 2 (worker + verdict).

**Tech Stack:** Bun, TypeScript, YAML (skill manifests), Claude Code skill format

---

### Task 1: Update PipelineStep Type and DEFAULT_PATHS

**Files:**
- Modify: `src/shared/types.ts:277-285` (PipelineStep interface)
- Modify: `src/shared/types.ts:365-402` (DEFAULT_PATHS)
- Modify: `src/engine/normalize.ts:1-108` (path normalization)
- Test: `tests/engine/normalize.test.ts` (if exists, else inline verification)

- [ ] **Step 1: Write failing test for new PipelineStep fields**

Create `tests/engine/normalize-v3.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { normalizePath } from "../../src/engine/normalize";

describe("v3 path normalization", () => {
  test("normalizes step with skills array", () => {
    const result = normalizePath({
      description: "test",
      steps: [
        { id: "review", type: "worker", skills: ["code-review"], sandbox: "read-only",
          result_file: ".grove/review-result.json", result_key: "approved", on_failure: "$fail" },
      ],
    });
    expect(result.steps[0].skills).toEqual(["code-review"]);
    expect(result.steps[0].sandbox).toBe("read-only");
    expect(result.steps[0].result_file).toBe(".grove/review-result.json");
    expect(result.steps[0].result_key).toBe("approved");
  });

  test("defaults sandbox to read-write", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "implement", type: "worker" }],
    });
    expect(result.steps[0].sandbox).toBe("read-write");
  });

  test("rejects gate type as unknown", () => {
    const result = normalizePath({
      description: "test",
      steps: [{ id: "evaluate", type: "gate" }],
    });
    // gate is no longer valid — normalize should treat it as worker
    expect(result.steps[0].type).toBe("worker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/engine/normalize-v3.test.ts`
Expected: FAIL — `skills`, `sandbox`, `result_file`, `result_key` not on PipelineStep

- [ ] **Step 3: Update PipelineStep interface**

In `src/shared/types.ts`, replace the PipelineStep interface (lines 277-285):

```typescript
export interface PipelineStep {
  id: string;
  type: "worker" | "verdict";
  prompt?: string;
  skills?: string[];
  sandbox?: "read-write" | "read-only";
  result_file?: string;
  result_key?: string;
  on_success: string;
  on_failure: string;
  max_retries?: number;
  label?: string;
}
```

- [ ] **Step 4: Update normalize.ts**

In `src/engine/normalize.ts`:

Replace `TYPE_INFERENCE` (lines 3-9):
```typescript
const TYPE_INFERENCE: Record<string, PipelineStep["type"]> = {
  verdict: "verdict",
};
```

Update the normalization in `normalizePath` to handle new fields. In the object branch (line 40-48), add:
```typescript
step = {
  id,
  type: props.type ?? TYPE_INFERENCE[id] ?? "worker",
  on_success: props.on_success ?? "",
  on_failure: props.on_failure ?? "",
  prompt: props.prompt,
  skills: props.skills,
  sandbox: props.sandbox ?? "read-write",
  result_file: props.result_file,
  result_key: props.result_key,
  max_retries: props.max_retries,
  label: props.label,
};
```

In the string branch (line 19-25), add defaults:
```typescript
step = {
  id: raw,
  type: TYPE_INFERENCE[raw] ?? "worker",
  on_success: "",
  on_failure: "",
  sandbox: "read-write",
};
```

Update the `on_failure` auto-fill logic (lines 70-86). Remove the gate/review special case — all steps with `sandbox: "read-only"` auto-fill to nearest preceding worker:
```typescript
for (let i = 0; i < steps.length; i++) {
  if (steps[i].on_failure === "") {
    if (steps[i].sandbox === "read-only") {
      for (let j = i - 1; j >= 0; j--) {
        if (steps[j].sandbox !== "read-only") {
          steps[i].on_failure = steps[j].id;
          break;
        }
      }
    }
    if (steps[i].on_failure === "") {
      steps[i].on_failure = "$fail";
    }
  }
}
```

- [ ] **Step 5: Update DEFAULT_PATHS**

In `src/shared/types.ts`, replace `DEFAULT_PATHS` (lines 365-402):

```typescript
export const DEFAULT_PATHS: Record<string, PathConfig> = {
  development: {
    description: "Standard dev workflow with review",
    steps: [
      { id: "implement", type: "worker", prompt: "Implement the task. Commit your changes with conventional commit messages." },
      { id: "review", type: "worker", skills: ["code-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "implement", max_retries: 2 },
      { id: "merge", type: "worker", skills: ["merge-handler"],
        result_file: ".grove/merge-result.json", result_key: "merged" },
    ],
  },
  research: {
    description: "Research task — produces a report, no code changes",
    steps: [
      { id: "research", type: "worker", prompt: "Conduct the research. Document findings as you go." },
      { id: "report", type: "worker", skills: ["research-report"], prompt: "Write a clear summary report of your findings in .grove/report.md in the worktree.", on_success: "$done" },
    ],
  },
  adversarial: {
    description: "Adversarial planning with review loop",
    steps: [
      { id: "plan", type: "worker", prompt: "Create a detailed implementation plan for this task. Write it to `.grove/plan.md`." },
      { id: "review-plan", type: "worker", skills: ["adversarial-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "plan", max_retries: 3 },
      { id: "implement", type: "worker", prompt: "Implement the approved plan from `.grove/plan.md`. Commit your changes with conventional commit messages." },
      { id: "review-code", type: "worker", skills: ["code-review"], sandbox: "read-only",
        result_file: ".grove/review-result.json", result_key: "approved", on_failure: "implement", max_retries: 2 },
      { id: "merge", type: "worker", skills: ["merge-handler"],
        result_file: ".grove/merge-result.json", result_key: "merged" },
    ],
  },
};
```

- [ ] **Step 6: Run tests to verify normalization passes**

Run: `bun test tests/engine/normalize-v3.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/engine/normalize.ts tests/engine/normalize-v3.test.ts
git commit -m "feat: update PipelineStep type for agent-based pipelines with skills"
```

---

### Task 2: Skill Library — Load, Install, Remove, List

**Files:**
- Create: `src/skills/library.ts`
- Create: `src/skills/types.ts`
- Test: `tests/skills/library.test.ts`

- [ ] **Step 1: Write skill types**

Create `src/skills/types.ts`:

```typescript
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  source?: string;
  suggested_steps?: string[];
  files: string[];
}

export interface InstalledSkill {
  manifest: SkillManifest;
  dir: string;
}
```

- [ ] **Step 2: Write failing tests for skill library**

Create `tests/skills/library.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { loadSkills, installSkillFromPath, removeSkill, getSkill } from "../../src/skills/library";

const TEST_DIR = join(import.meta.dir, "test-skills");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createTestSkill(name: string) {
  const skillDir = join(TEST_DIR, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.yaml"), [
    `name: ${name}`,
    `version: 1.0.0`,
    `description: Test skill ${name}`,
    `files:`,
    `  - skill.md`,
  ].join("\n"));
  writeFileSync(join(skillDir, "skill.md"), `# ${name}\nTest skill content`);
}

describe("loadSkills", () => {
  test("loads skills from directory", () => {
    createTestSkill("code-review");
    createTestSkill("tdd");
    const skills = loadSkills(TEST_DIR);
    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.manifest.name).sort()).toEqual(["code-review", "tdd"]);
  });

  test("returns empty array for empty directory", () => {
    expect(loadSkills(TEST_DIR)).toEqual([]);
  });

  test("skips directories without skill.yaml", () => {
    mkdirSync(join(TEST_DIR, "not-a-skill"), { recursive: true });
    writeFileSync(join(TEST_DIR, "not-a-skill", "random.txt"), "hello");
    expect(loadSkills(TEST_DIR)).toEqual([]);
  });
});

describe("getSkill", () => {
  test("returns skill by name", () => {
    createTestSkill("code-review");
    const skill = getSkill("code-review", TEST_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("code-review");
  });

  test("returns null for missing skill", () => {
    expect(getSkill("nonexistent", TEST_DIR)).toBeNull();
  });
});

describe("installSkillFromPath", () => {
  test("copies skill into library", () => {
    const srcDir = join(TEST_DIR, "_src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "skill.yaml"), "name: my-skill\nversion: 1.0.0\ndescription: test\nfiles:\n  - skill.md");
    writeFileSync(join(srcDir, "skill.md"), "# My Skill");

    const result = installSkillFromPath(srcDir, TEST_DIR);
    expect(result.ok).toBe(true);
    expect(existsSync(join(TEST_DIR, "my-skill", "skill.yaml"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "my-skill", "skill.md"))).toBe(true);
  });

  test("fails if no skill.yaml", () => {
    const srcDir = join(TEST_DIR, "_src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "random.md"), "nope");

    const result = installSkillFromPath(srcDir, TEST_DIR);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("skill.yaml");
  });
});

describe("removeSkill", () => {
  test("removes installed skill", () => {
    createTestSkill("old-skill");
    expect(removeSkill("old-skill", TEST_DIR)).toBe(true);
    expect(existsSync(join(TEST_DIR, "old-skill"))).toBe(false);
  });

  test("returns false for missing skill", () => {
    expect(removeSkill("nonexistent", TEST_DIR)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/skills/library.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement skill library**

Create `src/skills/library.ts`:

```typescript
import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SkillManifest, InstalledSkill } from "./types";

const DEFAULT_SKILLS_DIR = join(process.env.HOME ?? "~", ".grove", "skills");

export function skillsDir(): string {
  return process.env.GROVE_SKILLS_DIR ?? DEFAULT_SKILLS_DIR;
}

/** Load all installed skills from a directory */
export function loadSkills(dir?: string): InstalledSkill[] {
  const skillsPath = dir ?? skillsDir();
  if (!existsSync(skillsPath)) return [];

  const skills: InstalledSkill[] = [];
  for (const entry of readdirSync(skillsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(skillsPath, entry.name, "skill.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = parseYaml(raw) as SkillManifest;
      if (!manifest.name) manifest.name = entry.name;
      if (!manifest.files) manifest.files = [];
      skills.push({ manifest, dir: join(skillsPath, entry.name) });
    } catch {
      // Skip malformed skills
    }
  }
  return skills;
}

/** Get a single skill by name */
export function getSkill(name: string, dir?: string): InstalledSkill | null {
  const skillPath = join(dir ?? skillsDir(), name);
  const manifestPath = join(skillPath, "skill.yaml");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseYaml(raw) as SkillManifest;
    if (!manifest.name) manifest.name = name;
    if (!manifest.files) manifest.files = [];
    return { manifest, dir: skillPath };
  } catch {
    return null;
  }
}

/** Install a skill from a local path */
export function installSkillFromPath(
  srcPath: string,
  dir?: string,
): { ok: boolean; error?: string; name?: string } {
  const manifestPath = join(srcPath, "skill.yaml");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "Source directory does not contain skill.yaml" };
  }

  let manifest: SkillManifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, "utf-8")) as SkillManifest;
  } catch (err: any) {
    return { ok: false, error: `Failed to parse skill.yaml: ${err.message}` };
  }

  const name = manifest.name ?? basename(srcPath);
  const destPath = join(dir ?? skillsDir(), name);

  mkdirSync(destPath, { recursive: true });
  cpSync(srcPath, destPath, { recursive: true });

  return { ok: true, name };
}

/** Install a skill from a git URL */
export async function installSkillFromGit(
  url: string,
  dir?: string,
): Promise<{ ok: boolean; error?: string; name?: string }> {
  const tmpDir = join(dir ?? skillsDir(), `_tmp_${Date.now()}`);
  try {
    const result = Bun.spawnSync(["git", "clone", "--depth", "1", url, tmpDir], {
      timeout: 30_000,
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return { ok: false, error: `git clone failed: ${result.stderr.toString().trim()}` };
    }
    return installSkillFromPath(tmpDir, dir);
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Remove an installed skill */
export function removeSkill(name: string, dir?: string): boolean {
  const skillPath = join(dir ?? skillsDir(), name);
  if (!existsSync(skillPath)) return false;
  rmSync(skillPath, { recursive: true, force: true });
  return true;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/skills/library.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/skills/types.ts src/skills/library.ts tests/skills/library.test.ts
git commit -m "feat: add skill library — load, install, remove, list"
```

---

### Task 3: Skill Injector — Copy Skills into Worktrees

**Files:**
- Create: `src/skills/injector.ts`
- Test: `tests/skills/injector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/skills/injector.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { injectSkills } from "../../src/skills/injector";

const TEST_DIR = join(import.meta.dir, "test-inject");
const SKILLS_DIR = join(TEST_DIR, "skills");
const WORKTREE_DIR = join(TEST_DIR, "worktree");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(WORKTREE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createSkill(name: string, content: string) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), `name: ${name}\nversion: 1.0.0\ndescription: test\nfiles:\n  - skill.md`);
  writeFileSync(join(dir, "skill.md"), content);
}

describe("injectSkills", () => {
  test("copies skill files into worktree .claude/skills/", () => {
    createSkill("code-review", "# Code Review\nReview the code.");

    const result = injectSkills(["code-review"], WORKTREE_DIR, SKILLS_DIR);

    expect(result.injected).toEqual(["code-review"]);
    expect(result.missing).toEqual([]);
    const injectedPath = join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md");
    expect(existsSync(injectedPath)).toBe(true);
    expect(readFileSync(injectedPath, "utf-8")).toContain("Code Review");
  });

  test("injects multiple skills", () => {
    createSkill("code-review", "# Review");
    createSkill("security-audit", "# Security");

    const result = injectSkills(["code-review", "security-audit"], WORKTREE_DIR, SKILLS_DIR);

    expect(result.injected).toEqual(["code-review", "security-audit"]);
    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md"))).toBe(true);
    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "security-audit", "skill.md"))).toBe(true);
  });

  test("reports missing skills without failing", () => {
    createSkill("code-review", "# Review");

    const result = injectSkills(["code-review", "nonexistent"], WORKTREE_DIR, SKILLS_DIR);

    expect(result.injected).toEqual(["code-review"]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  test("handles empty skills array", () => {
    const result = injectSkills([], WORKTREE_DIR, SKILLS_DIR);
    expect(result.injected).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/skills/injector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement skill injector**

Create `src/skills/injector.ts`:

```typescript
import { join } from "node:path";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { getSkill, skillsDir } from "./library";

export interface InjectionResult {
  injected: string[];
  missing: string[];
}

/**
 * Copy skill files into a worktree's .claude/skills/ directory.
 * Missing skills are logged as warnings but don't fail the injection.
 */
export function injectSkills(
  skillNames: string[],
  worktreePath: string,
  skillsLibDir?: string,
): InjectionResult {
  const injected: string[] = [];
  const missing: string[] = [];
  const libDir = skillsLibDir ?? skillsDir();

  for (const name of skillNames) {
    const skill = getSkill(name, libDir);
    if (!skill) {
      console.warn(`[skills] Skill "${name}" not found in library — skipping`);
      missing.push(name);
      continue;
    }

    const destDir = join(worktreePath, ".claude", "skills", name);
    mkdirSync(destDir, { recursive: true });

    for (const file of skill.manifest.files) {
      const srcFile = join(skill.dir, file);
      if (!existsSync(srcFile)) {
        console.warn(`[skills] Skill "${name}" references missing file: ${file}`);
        continue;
      }
      cpSync(srcFile, join(destDir, file));
    }

    injected.push(name);
  }

  return { injected, missing };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/skills/injector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/injector.ts tests/skills/injector.test.ts
git commit -m "feat: add skill injector — copies skills into worktrees"
```

---

### Task 4: Update Worker to Accept Skills and Sandbox Mode

**Files:**
- Modify: `src/agents/worker.ts:29` (spawnWorker signature)
- Modify: `src/agents/worker.ts:82-97` (sandbox deployment)
- Modify: `src/agents/worker.ts:240-244` (completion — result file reading)
- Modify: `src/shared/sandbox.ts:15-21` (guard hook selection by sandbox mode)
- Modify: `src/shared/sandbox.ts:186-221` (deploySandbox to accept sandbox mode)
- Test: `tests/skills/worker-injection.test.ts`

- [ ] **Step 1: Write failing test for skill injection in worker**

Create `tests/skills/worker-injection.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { injectSkills } from "../../src/skills/injector";

const TEST_DIR = join(import.meta.dir, "test-worker-inject");
const SKILLS_DIR = join(TEST_DIR, "skills");
const WORKTREE_DIR = join(TEST_DIR, "worktree");

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(join(WORKTREE_DIR, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createSkill(name: string) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), `name: ${name}\nversion: 1.0.0\ndescription: test\nfiles:\n  - skill.md`);
  writeFileSync(join(dir, "skill.md"), `---\nname: ${name}\ndescription: Test skill\n---\n\nSkill content for ${name}`);
}

describe("worker skill injection integration", () => {
  test("skills are placed where Claude Code discovers them", () => {
    createSkill("code-review");
    injectSkills(["code-review"], WORKTREE_DIR, SKILLS_DIR);

    // Claude Code looks for skills in .claude/skills/<name>/
    const skillPath = join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md");
    expect(existsSync(skillPath)).toBe(true);

    // Verify it has Claude Code skill frontmatter
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("name: code-review");
  });

  test("multiple skills coexist in worktree", () => {
    createSkill("code-review");
    createSkill("tdd");
    injectSkills(["code-review", "tdd"], WORKTREE_DIR, SKILLS_DIR);

    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "code-review", "skill.md"))).toBe(true);
    expect(existsSync(join(WORKTREE_DIR, ".claude", "skills", "tdd", "skill.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (injector already exists)

Run: `bun test tests/skills/worker-injection.test.ts`
Expected: PASS — this validates the integration pattern works

- [ ] **Step 3: Update spawnWorker to accept PipelineStep**

In `src/agents/worker.ts`, change the `spawnWorker` signature (line 29) from:

```typescript
export function spawnWorker(task: Task, tree: Tree, db: Database, logDir: string, stepPrompt?: string): WorkerHandle {
```

To:

```typescript
import type { PipelineStep } from "../shared/types";
import { injectSkills } from "../skills/injector";

export function spawnWorker(task: Task, tree: Tree, db: Database, logDir: string, step?: PipelineStep): WorkerHandle {
```

Extract `stepPrompt` from the step: add after line 33:

```typescript
const stepPrompt = step?.prompt;
```

- [ ] **Step 4: Add skill injection before sandbox deployment**

In `spawnWorker`, after the worktree is created (after line 49) and before `deploySandbox` (line 83), add:

```typescript
  // Inject skills into worktree if the step declares any
  if (step?.skills?.length) {
    const injection = injectSkills(step.skills, worktreePath);
    if (injection.missing.length > 0) {
      db.addEvent(task.id, null, "skills_missing", `Missing skills: ${injection.missing.join(", ")}`);
    }
    if (injection.injected.length > 0) {
      db.addEvent(task.id, null, "skills_injected", `Injected skills: ${injection.injected.join(", ")}`);
    }
  }
```

- [ ] **Step 5: Pass sandbox mode to deploySandbox**

Update the `deploySandbox` call (line 83) to pass the sandbox mode:

```typescript
  deploySandbox(worktreePath, {
    taskId: task.id,
    title: task.title,
    description: task.description,
    treePath: tree.path,
    branch,
    pathName: task.path_name,
    workerInstructions: treeConfig.worker_instructions,
    sessionSummary: priorSummary,
    filesModified: task.files_modified,
    stepPrompt,
    seedSpec,
    reviewFeedback,
    checkpoint: checkpointCtx,
    sandbox: step?.sandbox ?? "read-write",
  });
```

- [ ] **Step 6: Update sandbox.ts to accept sandbox mode**

In `src/shared/sandbox.ts`, add `sandbox` to `OverlayContext` (line 36):

```typescript
export interface OverlayContext {
  // ... existing fields ...
  sandbox?: "read-write" | "read-only";
}
```

Update `deploySandbox` (line 187) to select guard hooks based on sandbox mode:

```typescript
export function deploySandbox(worktreePath: string, ctx: OverlayContext): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const hooks = ctx.sandbox === "read-only"
    ? buildReviewGuardHooks(worktreePath)
    : buildGuardHooks(worktreePath);
  // ... rest unchanged ...
```

- [ ] **Step 7: Add result file reading to worker completion**

In `monitorWorker` (around line 240-244), before the `onStepComplete` call, add result file reading. Replace:

```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: exitCode === 0 ? "done" : "failed" });
    bus.emit("agent:ended", { agentId: sessionId, role: "worker", taskId, exitCode: exitCode ?? 1, ts: Date.now() });
    const { onStepComplete } = await import("../engine/step-engine");
    onStepComplete(taskId, exitCode === 0 ? "success" : "failure");
```

With:

```typescript
    bus.emit("worker:ended", { taskId, sessionId, status: exitCode === 0 ? "done" : "failed" });
    bus.emit("agent:ended", { agentId: sessionId, role: "worker", taskId, exitCode: exitCode ?? 1, ts: Date.now() });

    // Determine outcome — check result file if configured, else use exit code
    const { onStepComplete, getStepForTask } = await import("../engine/step-engine");
    const step = getStepForTask(taskId);
    let outcome: "success" | "failure" = exitCode === 0 ? "success" : "failure";
    let context: string | undefined;

    if (step?.result_file) {
      const resultPath = join(handle.worktreePath, step.result_file);
      if (existsSync(resultPath)) {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf-8"));
          const key = step.result_key ?? "approved";
          outcome = result[key] ? "success" : "failure";
          context = result.feedback ?? result.reason;
        } catch {
          outcome = "failure";
          context = `Failed to parse result file: ${step.result_file}`;
        }
      } else {
        outcome = "failure";
        context = `Result file not found: ${step.result_file}`;
      }
    }

    onStepComplete(taskId, outcome, context);
```

- [ ] **Step 8: Add getStepForTask helper to step-engine.ts**

In `src/engine/step-engine.ts`, add a helper that returns the current step config for a task:

```typescript
/** Look up the current PipelineStep config for a task (used by worker for result_file). */
export function getStepForTask(taskId: string): PipelineStep | null {
  if (!_db) return null;
  const task = _db.taskGet(taskId);
  if (!task?.current_step) return null;

  const paths = configNormalizedPaths();
  const pathConfig = paths[task.path_name];
  if (!pathConfig) return null;

  return pathConfig.steps.find(s => s.id === task.current_step) ?? null;
}
```

- [ ] **Step 9: Update step engine executeStep to pass full step to worker**

In `src/engine/step-engine.ts`, update the worker case (lines 308-314):

```typescript
    case "worker": {
      const { spawnWorker } = await import("../agents/worker");
      const { getEnv } = await import("../broker/db");
      const logDir = getEnv().GROVE_LOG_DIR;
      spawnWorker(task, tree, db, logDir, step);
      break;
    }
```

- [ ] **Step 10: Run full test suite**

Run: `bun test`
Expected: Some existing tests may need updates (evaluator/reviewer tests). Note failures for Task 6.

- [ ] **Step 11: Commit**

```bash
git add src/agents/worker.ts src/shared/sandbox.ts src/engine/step-engine.ts tests/skills/worker-injection.test.ts
git commit -m "feat: worker accepts skills and sandbox mode from step config"
```

---

### Task 5: Remove Gate, Review, and Merge Step Types from Engine

**Files:**
- Modify: `src/engine/step-engine.ts:308-352` (remove gate/review/merge cases)
- Delete: `src/agents/evaluator.ts`
- Delete: `src/agents/reviewer.ts`
- Delete: `src/merge/manager.ts`
- Delete: `src/merge/github.ts`
- Modify: `src/plugins/types.ts:51-61` (remove GateHookInput/GateHookResult)
- Modify: `src/broker/index.ts` (remove evaluator/reviewer imports if present)

- [ ] **Step 1: Remove gate/review/merge cases from step engine**

In `src/engine/step-engine.ts`, replace the switch block (lines 308-352) with:

```typescript
  switch (step.type) {
    case "worker": {
      const { spawnWorker } = await import("../agents/worker");
      const { getEnv } = await import("../broker/db");
      const logDir = getEnv().GROVE_LOG_DIR;
      spawnWorker(task, tree, db, logDir, step);
      break;
    }

    case "verdict": {
      db.run(
        "UPDATE tasks SET status = 'waiting', paused = 1 WHERE id = ?",
        [task.id],
      );
      db.addEvent(task.id, null, "verdict_waiting", "Awaiting maintainer decision");
      bus.emit("task:status", { taskId: task.id, status: "waiting" });
      break;
    }

    default:
      failTask(db, task.id, `Unknown step type "${(step as any).type}"`);
  }
```

- [ ] **Step 2: Move buildRetryPrompt to shared utils**

Create or add to `src/shared/retry-prompt.ts`:

```typescript
/** Build a prompt for retrying a worker after review rejection or result file failure */
export function buildRetryPrompt(context?: string | null): string {
  if (!context) return "";
  return [
    "Your previous session's output was reviewed and rejected:",
    "",
    context,
    "",
    "Address the feedback above. The worktree still contains your previous work.",
    "Run tests before finishing to confirm they pass.",
  ].join("\n");
}
```

- [ ] **Step 3: Delete removed files**

```bash
rm src/agents/evaluator.ts
rm src/agents/reviewer.ts
rm src/merge/manager.ts
rm src/merge/github.ts
```

- [ ] **Step 3b: Remove QualityGatesConfig from types.ts**

In `src/shared/types.ts`, remove the `QualityGatesConfig` interface (lines 263-275) and the `quality_gates` field from `TreeConfig` (line 180). These were only used by the evaluator.

- [ ] **Step 3c: Remove `content` from DEFAULT_PATHS**

The `content` path used `type: "gate"` — either update it to use worker steps or remove it. Since `development` already covers content creation, remove it to keep the default paths minimal.

- [ ] **Step 4: Remove GateHookInput/GateHookResult from plugin types**

In `src/plugins/types.ts`, remove lines 51-61 (GateHookInput, GateHookResult interfaces). Keep StepPreHookInput, StepPostHookInput, and the other interfaces.

- [ ] **Step 5: Remove gate:custom hook usage from evaluator imports**

Search the codebase for any remaining imports of `evaluator`, `reviewer`, `manager`, or `github` from the deleted modules and remove them:

```bash
grep -r "from.*evaluator" src/ --include="*.ts"
grep -r "from.*reviewer" src/ --include="*.ts"
grep -r "from.*merge/manager" src/ --include="*.ts"
grep -r "from.*merge/github" src/ --include="*.ts"
```

Fix each import found.

- [ ] **Step 6: Run build to check for broken imports**

Run: `bun run build`
Expected: May fail if there are remaining references. Fix them.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: remove gate, review, merge step types — all steps are now workers"
```

---

### Task 6: Fix Broken Tests

**Files:**
- Delete: `tests/agents/evaluator-gates.test.ts`
- Delete: `tests/agents/reviewer.test.ts`
- Modify: `tests/engine/step-engine.test.ts` (update to use worker-only paths)

- [ ] **Step 1: Delete tests for removed modules**

```bash
rm tests/agents/evaluator-gates.test.ts
rm tests/agents/reviewer.test.ts
```

- [ ] **Step 2: Update step-engine tests**

In `tests/engine/step-engine.test.ts`, update any test that creates paths with `type: "gate"` or `type: "merge"` or `type: "review"` to use `type: "worker"` with appropriate `result_file`/`result_key` fields. Read the test file to determine exact changes needed — the key is replacing gate/merge/review step types with worker steps.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: PASS (all tests). If failures remain, fix them.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: update tests for agent-based pipeline — remove gate/reviewer tests"
```

---

### Task 7: Skills CLI Commands

**Files:**
- Create: `src/cli/commands/skills.ts`
- Modify: `src/cli/index.ts:6-26` (add skills command)
- Test: manual verification via `grove skills list`

- [ ] **Step 1: Write the skills CLI command**

Create `src/cli/commands/skills.ts`:

```typescript
import pc from "picocolors";
import { loadSkills, installSkillFromPath, installSkillFromGit, removeSkill, skillsDir } from "../../skills/library";
import { mkdirSync } from "node:fs";

export async function run(args: string[]) {
  const sub = args[0];

  switch (sub) {
    case "list":
    case "ls":
      return list();
    case "install":
    case "add":
      return install(args.slice(1));
    case "remove":
    case "rm":
      return remove(args.slice(1));
    default:
      return help();
  }
}

function list() {
  const skills = loadSkills();
  if (skills.length === 0) {
    console.log(pc.dim("No skills installed."));
    console.log(`Install with: ${pc.green("grove skills install <path-or-git-url>")}`);
    return;
  }

  console.log(pc.bold(`${skills.length} skill(s) installed:\n`));
  for (const skill of skills) {
    const suggested = skill.manifest.suggested_steps?.length
      ? pc.dim(` (${skill.manifest.suggested_steps.join(", ")})`)
      : "";
    console.log(`  ${pc.green(skill.manifest.name)} ${pc.dim(`v${skill.manifest.version}`)}${suggested}`);
    console.log(`  ${pc.dim(skill.manifest.description)}`);
    console.log();
  }
}

async function install(args: string[]) {
  const source = args[0];
  if (!source) {
    console.log(`${pc.red("Usage:")} grove skills install <path-or-git-url>`);
    return;
  }

  mkdirSync(skillsDir(), { recursive: true });

  const isGit = source.startsWith("http") || source.startsWith("git@") || source.endsWith(".git");

  if (isGit) {
    console.log(`Cloning ${source}...`);
    const result = await installSkillFromGit(source);
    if (!result.ok) {
      console.log(pc.red(result.error!));
      return;
    }
    console.log(pc.green(`Installed skill: ${result.name}`));
  } else {
    const result = installSkillFromPath(source);
    if (!result.ok) {
      console.log(pc.red(result.error!));
      return;
    }
    console.log(pc.green(`Installed skill: ${result.name}`));
  }
}

function remove(args: string[]) {
  const name = args[0];
  if (!name) {
    console.log(`${pc.red("Usage:")} grove skills remove <name>`);
    return;
  }

  if (removeSkill(name)) {
    console.log(pc.green(`Removed skill: ${name}`));
  } else {
    console.log(pc.red(`Skill "${name}" not found.`));
  }
}

function help() {
  console.log(`${pc.bold("grove skills")} — Manage the skill library

${pc.bold("Commands:")}
  ${pc.green("list")}      Show installed skills
  ${pc.green("install")}   Install a skill from a local path or git URL
  ${pc.green("remove")}    Remove an installed skill

${pc.bold("Examples:")}
  grove skills list
  grove skills install ./my-skill
  grove skills install https://github.com/user/grove-skill-review
  grove skills remove old-skill`);
}
```

- [ ] **Step 2: Register command in CLI router**

In `src/cli/index.ts`, add to the commands object (around line 23):

```typescript
  skills: () => import("./commands/skills"),
```

And add to the help text:

```typescript
  ${pc.green("skills")}    Manage the skill library
```

- [ ] **Step 3: Run build to verify**

Run: `bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/skills.ts src/cli/index.ts
git commit -m "feat: add grove skills CLI — install, list, remove"
```

---

### Task 8: Bundled Starter Skills

**Files:**
- Create: `skills/code-review/skill.yaml`
- Create: `skills/code-review/skill.md`
- Create: `skills/merge-handler/skill.yaml`
- Create: `skills/merge-handler/skill.md`
- Create: `skills/adversarial-review/skill.yaml`
- Create: `skills/adversarial-review/skill.md`
- Create: `skills/research-report/skill.yaml`
- Create: `skills/research-report/skill.md`

- [ ] **Step 1: Create code-review skill**

Create `skills/code-review/skill.yaml`:
```yaml
name: code-review
version: 1.0.0
description: Guided code review — runs tests, checks diff quality, verifies task completion
author: grove
suggested_steps: [review]
files:
  - skill.md
```

Create `skills/code-review/skill.md`:
```markdown
---
name: grove-code-review
description: Use when reviewing code changes for a grove task. Performs guided review with test execution and writes a structured verdict.
---

You are reviewing code changes made by a previous implementation agent for a grove task.

## Review Checklist

Work through each item. Report findings as you go.

1. **Run the test suite.** Execute the project's test command. Report pass/fail with counts. If tests fail, this is a hard reject — include the failure output.
2. **Check commits exist on the branch.** Run `git log main..HEAD --oneline`. If there are no commits and this is an implementation task (not research/analysis), reject. If the task is research or documentation, no commits is acceptable.
3. **Review the diff for quality.** Run `git diff main...HEAD`. Check for: incomplete implementations, commented-out code, debug statements left in, obvious bugs, missing error handling at system boundaries.
4. **Verify task completion.** Read the task description from `.claude/CLAUDE.md`. Does the implementation actually satisfy what was asked? Partial implementations should be rejected with specifics about what's missing.
5. **Check for security concerns.** Look for: hardcoded secrets, SQL injection, command injection, XSS, exposed credentials in commits.

## Judgment Rules

- If tests fail → reject, include failure output
- If implementation doesn't match the task → reject, explain what's missing
- If no commits on an implementation task → reject
- If only minor style issues → approve with notes
- Use judgment for edge cases — a missing commit on a docs-only task is fine

## Output

Write your verdict to `.grove/review-result.json`:

```json
{
  "approved": true,
  "feedback": "Tests pass (42 passed, 0 failed). Implementation matches task requirements. Minor: consider adding a comment to the complex regex on line 78."
}
```

Or on rejection:

```json
{
  "approved": false,
  "feedback": "Tests fail: 3 failures in auth.test.ts. TypeError: Cannot read properties of undefined (reading 'token') at line 55. Fix the null check before accessing user.token."
}
```

Always include specific, actionable feedback. The implementation agent will use this to fix issues.
```

- [ ] **Step 2: Create merge-handler skill**

Create `skills/merge-handler/skill.yaml`:
```yaml
name: merge-handler
version: 1.0.0
description: Push branch, create PR, monitor CI, merge on green
author: grove
suggested_steps: [merge]
files:
  - skill.md
```

Create `skills/merge-handler/skill.md`:
```markdown
---
name: grove-merge-handler
description: Use when merging completed work — pushes branch, creates PR, monitors CI, and merges.
---

You are handling the merge step for a grove task. Your job is to get this code merged.

## Steps

1. **Push the branch.** Run `git push origin HEAD` from the worktree. If the push fails, report the error.

2. **Create a PR.** Use `gh pr create` with:
   - Title: the task title from `.claude/CLAUDE.md`
   - Body: a summary of changes (read `.grove/session-summary.md` if it exists)
   - Base: the default branch (usually `main`)
   
   If a PR already exists for this branch, skip creation and use the existing one.

3. **Wait for CI.** Run `gh pr checks` in a loop (check every 15 seconds, max 10 minutes). If CI passes, proceed. If CI fails, report the failure details.

4. **Merge the PR.** Run `gh pr merge --squash --delete-branch`. If merge fails due to conflicts, report the conflict.

## Output

Write your result to `.grove/merge-result.json`:

On success:
```json
{
  "merged": true,
  "pr_number": 42,
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

On failure:
```json
{
  "merged": false,
  "reason": "CI failed: test_auth.py — assertion error on line 42",
  "pr_number": 42,
  "pr_url": "https://github.com/org/repo/pull/42"
}
```

## Important

- Do NOT push to remote branches other than the task branch.
- Do NOT force push.
- If the PR has merge conflicts, report them — do not resolve them yourself.
- Close any related GitHub issues mentioned in the PR body.
```

- [ ] **Step 3: Create adversarial-review skill**

Create `skills/adversarial-review/skill.yaml`:
```yaml
name: adversarial-review
version: 1.0.0
description: Strict plan critique — backwards compatibility, edge cases, test strategy
author: grove
suggested_steps: [review-plan]
files:
  - skill.md
```

Create `skills/adversarial-review/skill.md`:
```markdown
---
name: grove-adversarial-review
description: Use when reviewing an implementation plan before coding begins. Rigorous adversarial critique.
---

You are an adversarial reviewer critiquing an implementation plan. Your job is to find problems BEFORE code is written.

## What to Review

Read `.grove/plan.md` (or the plan content in `.claude/CLAUDE.md`). Examine the codebase for context. Critique for:

1. **Correctness** — Will this approach actually work? Are there logical errors in the plan?
2. **Backwards compatibility** — Does this break existing behavior? Check existing tests and API contracts.
3. **Missing edge cases** — What inputs, states, or timing issues aren't handled?
4. **Test coverage gaps** — Does the plan include tests? Are important paths untested?
5. **API design quality** — Are interfaces clear? Are naming conventions consistent with the codebase?
6. **Scope creep** — Is the plan doing more than the task requires?

## Judgment Rules

- Reject vague plans ("implement the feature") — demand specifics
- Reject plans that don't mention testing
- Reject plans that break backwards compatibility without explicit justification
- Approve plans that are specific, testable, and scoped

## Output

Write your verdict to `.grove/review-result.json`:

```json
{
  "approved": false,
  "feedback": "Plan doesn't address backwards compatibility. The UserService.getById() method is used by 3 other modules — changing its return type will break them. Either: (a) add a new method and deprecate the old one, or (b) update all callers in the same PR."
}
```

Always be specific. "Needs more detail" is not actionable. Say exactly what detail is missing.
```

- [ ] **Step 4: Create research-report skill**

Create `skills/research-report/skill.yaml`:
```yaml
name: research-report
version: 1.0.0
description: Summarize research findings into a structured report
author: grove
suggested_steps: [report]
files:
  - skill.md
```

Create `skills/research-report/skill.md`:
```markdown
---
name: grove-research-report
description: Use when summarizing research findings into a final report.
---

You are writing the final report for a research task. Summarize findings clearly.

## Instructions

1. Read the research notes from prior sessions (check `.grove/session-summary.md` and any notes in the worktree).
2. Write a structured report to `.grove/report.md` with:
   - **Summary** — key findings in 2-3 sentences
   - **Details** — organized by topic
   - **Recommendations** — actionable next steps
   - **Sources** — files, docs, or URLs consulted
3. Keep it concise. The audience is a developer who needs to act on these findings.
```

- [ ] **Step 5: Commit**

```bash
git add skills/
git commit -m "feat: add 4 bundled starter skills — code-review, merge-handler, adversarial-review, research-report"
```

---

### Task 9: Config Migration v2 → v3

**Files:**
- Modify: `src/broker/config.ts` (add migration logic)
- Modify: `src/shared/types.ts` (bump CONFIG_VERSION)
- Test: `tests/broker/config-migration.test.ts`

- [ ] **Step 1: Write failing test for migration**

Create `tests/broker/config-migration.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { migrateV2toV3 } from "../../src/broker/config";

describe("v2 to v3 config migration", () => {
  test("converts gate step to worker with code-review skill", () => {
    const v2 = {
      version: 2,
      paths: {
        development: {
          description: "test",
          steps: [
            { id: "implement", type: "worker" },
            { id: "evaluate", type: "gate", on_failure: "implement" },
            { id: "merge", type: "merge" },
          ],
        },
      },
    };
    const v3 = migrateV2toV3(v2);
    expect(v3.version).toBe(3);

    const steps = v3.paths.development.steps;
    expect(steps[1].type).toBe("worker");
    expect(steps[1].skills).toEqual(["code-review"]);
    expect(steps[1].sandbox).toBe("read-only");
    expect(steps[1].result_file).toBe(".grove/review-result.json");
    expect(steps[1].result_key).toBe("approved");

    expect(steps[2].type).toBe("worker");
    expect(steps[2].skills).toEqual(["merge-handler"]);
    expect(steps[2].result_file).toBe(".grove/merge-result.json");
    expect(steps[2].result_key).toBe("merged");
  });

  test("converts review step to worker with read-only sandbox", () => {
    const v2 = {
      version: 2,
      paths: {
        adversarial: {
          description: "test",
          steps: [
            { id: "plan", type: "worker" },
            { id: "review", type: "review", prompt: "Critique this plan.", on_failure: "plan" },
          ],
        },
      },
    };
    const v3 = migrateV2toV3(v2);
    const reviewStep = v3.paths.adversarial.steps[1];
    expect(reviewStep.type).toBe("worker");
    expect(reviewStep.sandbox).toBe("read-only");
    expect(reviewStep.prompt).toBe("Critique this plan.");
    expect(reviewStep.result_file).toBe(".grove/review-result.json");
    expect(reviewStep.result_key).toBe("approved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/config-migration.test.ts`
Expected: FAIL — `migrateV2toV3` not found

- [ ] **Step 3: Implement migration**

In `src/broker/config.ts`, add:

```typescript
export function migrateV2toV3(config: any): any {
  const migrated = JSON.parse(JSON.stringify(config));
  migrated.version = 3;

  if (migrated.paths) {
    for (const [name, path] of Object.entries(migrated.paths) as any[]) {
      if (!path.steps) continue;
      path.steps = path.steps.map((step: any) => {
        if (step.type === "gate") {
          return {
            ...step,
            type: "worker",
            skills: ["code-review"],
            sandbox: "read-only",
            result_file: ".grove/review-result.json",
            result_key: "approved",
          };
        }
        if (step.type === "merge") {
          return {
            ...step,
            type: "worker",
            skills: step.skills ?? ["merge-handler"],
            result_file: ".grove/merge-result.json",
            result_key: "merged",
          };
        }
        if (step.type === "review") {
          return {
            ...step,
            type: "worker",
            sandbox: "read-only",
            result_file: ".grove/review-result.json",
            result_key: "approved",
          };
        }
        return step;
      });
    }
  }

  return migrated;
}
```

Update `CONFIG_VERSION` constant to `3` and wire `migrateV2toV3` into the existing migration chain in `grove config migrate`.

- [ ] **Step 4: Run test**

Run: `bun test tests/broker/config-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/config.ts tests/broker/config-migration.test.ts
git commit -m "feat: config migration v2 → v3 — converts gate/merge/review to worker steps"
```

---

### Task 10: Bundled Skill Auto-Install on First Run

**Files:**
- Modify: `src/broker/index.ts` (add skill bootstrap on startup)

- [ ] **Step 1: Add skill bootstrap to broker startup**

In `src/broker/index.ts`, after the plugin host initialization, add:

```typescript
  // Bootstrap bundled skills if not already installed
  const { bootstrapBundledSkills } = await import("../skills/library");
  bootstrapBundledSkills();
```

- [ ] **Step 2: Implement bootstrapBundledSkills**

In `src/skills/library.ts`, add:

```typescript
import { join, dirname } from "node:path";

/** Copy bundled skills from the grove repo into ~/.grove/skills/ if not already present */
export function bootstrapBundledSkills(): void {
  const bundledDir = join(dirname(dirname(dirname(import.meta.dir))), "skills");
  if (!existsSync(bundledDir)) return;

  const targetDir = skillsDir();
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetSkill = join(targetDir, entry.name);
    if (existsSync(targetSkill)) continue; // Don't overwrite user customizations

    const srcSkill = join(bundledDir, entry.name);
    if (!existsSync(join(srcSkill, "skill.yaml"))) continue;

    cpSync(srcSkill, targetSkill, { recursive: true });
    console.log(`[skills] Installed bundled skill: ${entry.name}`);
  }
}
```

- [ ] **Step 3: Run build and verify**

Run: `bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/broker/index.ts src/skills/library.ts
git commit -m "feat: auto-install bundled skills on first broker startup"
```

---

### Task 11: Final Integration Test and Cleanup

**Files:**
- Run full test suite and build
- Clean up any remaining references to deleted modules

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 3: Search for dead references**

```bash
grep -r "evaluator" src/ --include="*.ts" -l
grep -r "reviewer" src/ --include="*.ts" -l
grep -r "merge/manager" src/ --include="*.ts" -l
grep -r "merge/github" src/ --include="*.ts" -l
grep -r "type.*gate" src/ --include="*.ts" -l
grep -r "gate:custom" src/ --include="*.ts" -l
```

Fix any remaining references.

- [ ] **Step 4: Verify grove.yaml default paths work**

Run `grove config validate` to check the new default paths are valid.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: clean up dead references to removed gate/merge/review modules"
```

- [ ] **Step 6: Bump version**

Update `GROVE_VERSION` in `src/shared/types.ts` to `0.2.0` (minor bump for breaking change).

```bash
git add src/shared/types.ts
git commit -m "chore(release): v0.2.0 — agent-based pipelines with skill injection"
```
