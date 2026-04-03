// grove init — Initialize ~/.grove with config and database
import { existsSync, mkdirSync } from "node:fs";
import pc from "picocolors";
import { getEnv, Database } from "../../broker/db";
import { writeDefaultConfig } from "../../broker/config";
import { SCHEMA_SQL } from "../../broker/schema-sql";

export async function run(_args: string[]) {
  const { GROVE_HOME, GROVE_DB, GROVE_CONFIG, GROVE_LOG_DIR } = getEnv();

  if (existsSync(GROVE_HOME)) {
    console.log(`${pc.yellow("Grove already initialized at")} ${GROVE_HOME}`);
    console.log(`Config: ${GROVE_CONFIG}`);
    console.log(`Database: ${GROVE_DB}`);
    return;
  }

  mkdirSync(GROVE_HOME, { recursive: true });
  mkdirSync(GROVE_LOG_DIR, { recursive: true });

  writeDefaultConfig(GROVE_CONFIG);

  const db = new Database(GROVE_DB);
  db.initFromString(SCHEMA_SQL);
  db.close();

  // Install bundled skills (merge-handler, code-review, etc.) into ~/.grove/skills/
  try {
    const { bootstrapBundledSkills } = await import("../../skills/library");
    bootstrapBundledSkills();
  } catch {
    // Non-fatal — skills will also be bootstrapped on `grove up`
  }

  console.log(`${pc.green("✓")} Grove initialized at ${pc.bold(GROVE_HOME)}`);
  console.log(`  Config: ${GROVE_CONFIG}`);
  console.log(`  Database: ${GROVE_DB}`);
  console.log(`  Logs: ${GROVE_LOG_DIR}`);
  console.log();
  console.log(`Next: edit ${pc.bold("grove.yaml")} to add your trees, then run ${pc.bold("grove up")}`);
}
