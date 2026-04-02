import { readdirSync, existsSync, mkdirSync, cpSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { InstalledSkill, SkillManifest } from "./types";

export function skillsDir(): string {
  return process.env.GROVE_SKILLS_DIR ?? join(homedir(), ".grove", "skills");
}

export function loadSkills(dir?: string): InstalledSkill[] {
  const root = dir ?? skillsDir();
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const skills: InstalledSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(root, entry.name);
    const manifestPath = join(skillDir, "skill.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = parseYaml(raw) as SkillManifest;
      skills.push({ manifest, dir: skillDir });
    } catch {
      // skip malformed manifests
    }
  }

  return skills;
}

export function getSkill(name: string, dir?: string): InstalledSkill | null {
  const root = dir ?? skillsDir();
  const skillDir = join(root, name);
  const manifestPath = join(skillDir, "skill.yaml");

  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseYaml(raw) as SkillManifest;
    return { manifest, dir: skillDir };
  } catch {
    return null;
  }
}

export function installSkillFromPath(
  srcPath: string,
  dir?: string
): { ok: boolean; error?: string; name?: string } {
  const manifestPath = join(srcPath, "skill.yaml");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "No skill.yaml found in source directory" };
  }

  let manifest: SkillManifest;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    manifest = parseYaml(raw) as SkillManifest;
  } catch (err: any) {
    return { ok: false, error: `Failed to parse skill.yaml: ${err.message}` };
  }

  if (!manifest.name) {
    return { ok: false, error: "skill.yaml missing required field: name" };
  }

  const root = dir ?? skillsDir();
  mkdirSync(root, { recursive: true });
  const destDir = join(root, manifest.name);

  try {
    cpSync(resolve(srcPath), destDir, { recursive: true, force: true });
  } catch (err: any) {
    return { ok: false, error: `Failed to copy skill: ${err.message}` };
  }

  return { ok: true, name: manifest.name };
}

export async function installSkillFromGit(
  url: string,
  dir?: string
): Promise<{ ok: boolean; error?: string; name?: string }> {
  const tmpDir = join(homedir(), ".grove", "tmp", `skill-clone-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmpDir], { stdio: "pipe" });
  } catch (err: any) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `git clone failed: ${err.message}` };
  }

  const result = installSkillFromPath(tmpDir, dir);

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  return result;
}

export function removeSkill(name: string, dir?: string): boolean {
  const root = dir ?? skillsDir();
  const skillDir = join(root, name);

  if (!existsSync(skillDir)) return false;

  try {
    rmSync(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Copy bundled skills from the grove repo into ~/.grove/skills/ if not already present */
export function bootstrapBundledSkills(): void {
  // The bundled skills are in the repo at <project-root>/skills/
  // We need to find that directory relative to this module's location.
  // In the compiled binary, this path will be different from development.

  // Try multiple strategies to find the bundled skills directory:
  // 1. Relative to the module (development): ../../skills/
  // 2. Via GROVE_BUNDLED_SKILLS env var (for compiled binary)

  const candidates = [
    join(dirname(dirname(__dirname)), "skills"),  // development: src/skills/library.ts → ../../skills/
    process.env.GROVE_BUNDLED_SKILLS,
  ].filter(Boolean) as string[];

  let bundledDir: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      bundledDir = candidate;
      break;
    }
  }

  if (!bundledDir) return;

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
