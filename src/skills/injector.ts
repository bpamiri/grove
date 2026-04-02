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
