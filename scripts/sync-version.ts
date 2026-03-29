#!/usr/bin/env bun
// Syncs GROVE_VERSION in src/shared/types.ts with the version in package.json.
// Called during the release workflow after changelogen bumps package.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;

const typesPath = join(ROOT, "src/shared/types.ts");
const content = readFileSync(typesPath, "utf-8");

const PATTERN = /export const GROVE_VERSION = ".*";/;

if (!PATTERN.test(content)) {
  console.error("ERROR: GROVE_VERSION line not found in types.ts");
  process.exit(1);
}

const updated = content.replace(
  PATTERN,
  `export const GROVE_VERSION = "${version}";`
);

if (updated === content) {
  console.log(`GROVE_VERSION already at ${version}, no change needed`);
} else {
  writeFileSync(typesPath, updated);
  console.log(`Synced GROVE_VERSION to ${version}`);
}
