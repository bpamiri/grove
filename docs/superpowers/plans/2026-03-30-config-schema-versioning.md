# T8: Configuration Schema Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `version` field to grove.yaml, a migration system that transforms configs between versions, and CLI commands for config management.

**Architecture:** Configs without a `version` field are treated as v1. A migration runner applies transforms sequentially (v1→v2→...→latest). Broker logs a warning on startup if config is old. `grove config migrate` backs up and upgrades on disk; `grove config validate` reports errors.

**Tech Stack:** Bun, TypeScript, YAML (existing `yaml` package)

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T8 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/broker/config-migrations.ts` | Migration definitions + runner |
| Create | `tests/broker/config-migrations.test.ts` | Migration unit tests |
| Create | `src/cli/commands/config.ts` | CLI subcommands (migrate, validate, version) |
| Modify | `src/shared/types.ts` | Add `version` to GroveConfig |
| Modify | `src/broker/config.ts` | Version detection, auto-migration on load, validation |
| Modify | `src/cli/index.ts` | Register config subcommand |

---

### Task 1: Migration System

**Files:**
- Create: `src/broker/config-migrations.ts`
- Create: `tests/broker/config-migrations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/broker/config-migrations.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { migrateConfig, latestVersion, detectVersion } from "../../src/broker/config-migrations";

describe("detectVersion", () => {
  test("returns 1 for config without version field", () => {
    expect(detectVersion({ workspace: { name: "test" } })).toBe(1);
  });

  test("returns version field when present", () => {
    expect(detectVersion({ version: 2, workspace: { name: "test" } })).toBe(2);
  });

  test("returns 1 for null/undefined", () => {
    expect(detectVersion(null)).toBe(1);
    expect(detectVersion(undefined)).toBe(1);
  });
});

describe("latestVersion", () => {
  test("returns a number >= 2", () => {
    expect(latestVersion()).toBeGreaterThanOrEqual(2);
  });
});

describe("migrateConfig", () => {
  test("migrates v1 config to latest", () => {
    const v1 = {
      workspace: { name: "Test" },
      trees: {},
      paths: {},
      budgets: { per_task: 5, per_session: 10, per_day: 25, per_week: 100, auto_approve_under: 2 },
      server: { port: "auto" },
      tunnel: { provider: "cloudflare", auth: "token" },
      settings: { max_workers: 5, branch_prefix: "grove/", stall_timeout_minutes: 5, max_retries: 2 },
    };
    const { config, applied } = migrateConfig(v1);
    expect(config.version).toBe(latestVersion());
    expect(applied.length).toBeGreaterThan(0);
    expect(config.settings.default_adapter).toBe("claude-code");
  });

  test("returns empty applied for already-latest config", () => {
    const latest = {
      version: latestVersion(),
      workspace: { name: "Test" },
      settings: { default_adapter: "claude-code" },
    };
    const { config, applied } = migrateConfig(latest);
    expect(applied.length).toBe(0);
    expect(config.version).toBe(latestVersion());
  });

  test("preserves user values during migration", () => {
    const v1 = {
      workspace: { name: "My Grove" },
      settings: { max_workers: 10, branch_prefix: "custom/", stall_timeout_minutes: 15, max_retries: 3 },
    };
    const { config } = migrateConfig(v1);
    expect(config.workspace.name).toBe("My Grove");
    expect(config.settings.max_workers).toBe(10);
    expect(config.settings.branch_prefix).toBe("custom/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/broker/config-migrations.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement migration system**

Create `src/broker/config-migrations.ts`:

```typescript
// Grove v3 — Configuration schema versioning and migration

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

/** Detect the version of a config object */
export function detectVersion(config: any): number {
  if (!config || typeof config !== "object") return 1;
  return typeof config.version === "number" ? config.version : 1;
}

/** Get the latest schema version */
export function latestVersion(): number {
  if (migrations.length === 0) return 2;
  return migrations[migrations.length - 1].to;
}

/** Run all necessary migrations from current version to latest */
export function migrateConfig(config: any): { config: any; applied: string[] } {
  const applied: string[] = [];
  let current = detectVersion(config);
  const target = latestVersion();

  while (current < target) {
    const migration = migrations.find(m => m.from === current);
    if (!migration) {
      throw new Error(`No migration found from version ${current}`);
    }
    config = migration.migrate({ ...config });
    applied.push(migration.description);
    current = migration.to;
  }

  // Ensure version is set
  config.version = target;
  return { config, applied };
}

/** Validate config for common issues */
export function validateConfig(config: any): string[] {
  const errors: string[] = [];
  const version = detectVersion(config);

  if (version > latestVersion()) {
    errors.push(`Config version ${version} is newer than supported (${latestVersion()}). Upgrade Grove.`);
  }

  if (!config?.workspace?.name) {
    errors.push("Missing workspace.name");
  }

  if (config?.trees) {
    for (const [id, tree] of Object.entries(config.trees as Record<string, any>)) {
      if (!tree?.path) errors.push(`Tree "${id}" missing path`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/broker/config-migrations.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/config-migrations.ts tests/broker/config-migrations.test.ts
git commit -m "feat: add config migration system with v1→v2 migration"
```

---

### Task 2: Wire Migrations into Config Loading

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/broker/config.ts`

- [ ] **Step 1: Add version to GroveConfig**

In `src/shared/types.ts`, add `version` as the first field of `GroveConfig`:

```typescript
export interface GroveConfig {
  version?: number;
  workspace: { name: string };
  // ... rest unchanged
```

- [ ] **Step 2: Wire migration into loadConfig**

In `src/broker/config.ts`, add import at top:

```typescript
import { detectVersion, latestVersion, migrateConfig as runMigrations } from "./config-migrations";
```

In the `loadConfig()` function, after reading and parsing the YAML but before merging defaults, add migration:

Find the line where raw config is parsed (after `yaml.parse()`), and add:

```typescript
  // Detect version and migrate in-memory if needed
  const version = detectVersion(raw);
  const latest = latestVersion();
  if (version < latest) {
    console.warn(`[config] grove.yaml is version ${version}, latest is ${latest}. Run 'grove config migrate' to upgrade.`);
    const { config: migrated } = runMigrations(raw);
    raw = migrated;
  }
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/broker/config.ts
git commit -m "feat: wire config migrations into loadConfig with version warning"
```

---

### Task 3: CLI Config Commands

**Files:**
- Create: `src/cli/commands/config.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Create config CLI command**

Create `src/cli/commands/config.ts`:

```typescript
// grove config — Configuration management
import pc from "picocolors";
import { loadConfig } from "../../broker/config";
import { detectVersion, latestVersion, migrateConfig, validateConfig } from "../../broker/config-migrations";

export async function run(args: string[]) {
  const sub = args[0];

  switch (sub) {
    case "version": {
      const config = loadConfig();
      const current = detectVersion(config);
      const latest = latestVersion();
      console.log(`Current: v${current}`);
      console.log(`Latest:  v${latest}`);
      if (current < latest) {
        console.log(`${pc.yellow("⚠")} Config is outdated. Run ${pc.bold("grove config migrate")} to upgrade.`);
      } else {
        console.log(`${pc.green("✓")} Config is up to date.`);
      }
      break;
    }

    case "validate": {
      const config = loadConfig();
      const errors = validateConfig(config);
      if (errors.length === 0) {
        console.log(`${pc.green("✓")} Config is valid.`);
      } else {
        console.log(`${pc.red("Issues found:")}`);
        for (const err of errors) {
          console.log(`  ${pc.yellow("•")} ${err}`);
        }
      }
      break;
    }

    case "migrate": {
      const { readFileSync, writeFileSync, copyFileSync } = await import("node:fs");
      const { getEnv } = await import("../../broker/db");
      const yaml = await import("yaml");
      const { GROVE_CONFIG } = getEnv();

      const raw = yaml.parse(readFileSync(GROVE_CONFIG, "utf-8"));
      const current = detectVersion(raw);
      const latest = latestVersion();

      if (current >= latest) {
        console.log(`${pc.green("✓")} Config is already at v${latest}. Nothing to migrate.`);
        break;
      }

      // Backup
      const backupPath = GROVE_CONFIG + ".bak";
      copyFileSync(GROVE_CONFIG, backupPath);
      console.log(`${pc.dim("Backup:")} ${backupPath}`);

      // Migrate
      const { config: migrated, applied } = migrateConfig(raw);

      // Write
      writeFileSync(GROVE_CONFIG, yaml.stringify(migrated));
      console.log(`${pc.green("✓")} Migrated v${current} → v${latest}`);
      for (const desc of applied) {
        console.log(`  ${pc.dim("•")} ${desc}`);
      }
      break;
    }

    default:
      console.log(`${pc.bold("grove config")} — Configuration management

${pc.bold("Usage:")} grove config <command>

${pc.bold("Commands:")}
  ${pc.green("version")}     Show current and latest config version
  ${pc.green("validate")}    Check config for errors
  ${pc.green("migrate")}     Upgrade config to latest version (creates .bak backup)
`);
  }
}
```

- [ ] **Step 2: Register in CLI index**

In `src/cli/index.ts`, add to the commands object:

```typescript
  config: () => import("./commands/config"),
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/config.ts src/cli/index.ts
git commit -m "feat: add grove config CLI commands (version, validate, migrate)"
```
