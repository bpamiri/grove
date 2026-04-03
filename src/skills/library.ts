import { readdirSync, existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

export type EmbeddedSkills = Record<string, Record<string, string>>;

export interface BootstrapResult {
  installed: string[];
  skipped: string[];
  source: "filesystem" | "embedded" | "none";
}

export interface BootstrapOptions {
  bundledDir?: string;
  targetDir?: string;
  embeddedSkills?: EmbeddedSkills;
}

/** Find the bundled skills/ directory on the filesystem */
function findBundledSkillsDir(): string | null {
  const candidates = [
    join(dirname(dirname(__dirname)), "skills"),           // dev: src/skills/library.ts → ../../skills/
    join(dirname(process.execPath), "skills"),              // compiled: next to the binary
    process.env.GROVE_BUNDLED_SKILLS,                      // explicit override
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Try loading embedded skill data from the generated module */
function loadEmbeddedSkills(): EmbeddedSkills | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./bundled-skills.generated");
    return mod.BUNDLED_SKILLS ?? null;
  } catch {
    return null;
  }
}

/** Copy bundled skills into ~/.grove/skills/ if not already present */
export function bootstrapBundledSkills(opts?: BootstrapOptions): BootstrapResult {
  const target = opts?.targetDir ?? skillsDir();
  const installed: string[] = [];
  const skipped: string[] = [];

  // --- Strategy 1: filesystem ---
  const fsDir = opts?.bundledDir
    ? (existsSync(opts.bundledDir) ? opts.bundledDir : null)
    : findBundledSkillsDir();

  if (fsDir) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(fsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(fsDir, entry.name, "skill.yaml"))) continue;
      if (existsSync(join(target, entry.name))) {
        skipped.push(entry.name);
        continue;
      }
      cpSync(join(fsDir, entry.name), join(target, entry.name), { recursive: true });
      installed.push(entry.name);
    }
    if (installed.length > 0) {
      console.log(`[skills] Bootstrapped ${installed.length} bundled skill(s): ${installed.join(", ")}`);
    }
    return { installed, skipped, source: "filesystem" };
  }

  // --- Strategy 2: embedded data (compiled binary) ---
  const embedded = opts?.embeddedSkills ?? loadEmbeddedSkills();

  if (embedded && Object.keys(embedded).length > 0) {
    mkdirSync(target, { recursive: true });
    for (const [name, files] of Object.entries(embedded)) {
      if (existsSync(join(target, name))) {
        skipped.push(name);
        continue;
      }
      const skillDir = join(target, name);
      mkdirSync(skillDir, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        writeFileSync(join(skillDir, filename), content, "utf-8");
      }
      installed.push(name);
    }
    if (installed.length > 0) {
      console.log(`[skills] Bootstrapped ${installed.length} bundled skill(s) from embedded data: ${installed.join(", ")}`);
    }
    return { installed, skipped, source: "embedded" };
  }

  // --- No source available ---
  console.warn(
    "[skills] No bundled skills directory found — skills will not be bootstrapped. " +
    "Set GROVE_BUNDLED_SKILLS or reinstall grove.",
  );
  return { installed, skipped, source: "none" };
}
