// Grove v3 — Config schema versioning and migration system

interface Migration {
  from: number;
  to: number;
  description: string;
  migrate(config: any): any;
}

const migrations: Migration[] = [
  {
    from: 1,
    to: 2,
    description: "Add default_adapter to settings, add version field",
    migrate(config: any): any {
      config.version = 2;
      if (!config.settings) config.settings = {};
      config.settings.default_adapter ??= "claude-code";
      return config;
    },
  },
];

export function detectVersion(config: any): number {
  if (!config || typeof config !== "object") return 1;
  return typeof config.version === "number" ? config.version : 1;
}

export function latestVersion(): number {
  if (migrations.length === 0) return 2;
  return migrations[migrations.length - 1].to;
}

export function migrateConfig(config: any): { config: any; applied: string[] } {
  const applied: string[] = [];
  let current = detectVersion(config);
  const target = latestVersion();
  while (current < target) {
    const migration = migrations.find((m) => m.from === current);
    if (!migration) throw new Error(`No migration found from version ${current}`);
    config = migration.migrate({ ...config });
    applied.push(migration.description);
    current = migration.to;
  }
  config.version = target;
  return { config, applied };
}

export function validateConfig(config: any): string[] {
  const errors: string[] = [];
  const version = detectVersion(config);
  if (version > latestVersion())
    errors.push(`Config version ${version} is newer than supported (${latestVersion()}). Upgrade Grove.`);
  if (!config?.workspace?.name) errors.push("Missing workspace.name");
  if (config?.trees) {
    for (const [id, tree] of Object.entries(config.trees as Record<string, any>)) {
      if (!tree?.path) errors.push(`Tree "${id}" missing path`);
    }
  }
  return errors;
}
