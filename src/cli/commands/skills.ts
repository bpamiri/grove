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
