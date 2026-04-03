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
