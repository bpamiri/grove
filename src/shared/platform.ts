// Grove v3 — Cross-platform helpers
// Centralizes all platform-specific logic so the rest of the codebase stays portable.
import { homedir, tmpdir, platform } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Cross-platform Grove home directory */
export function groveHome(): string {
  return process.env.GROVE_HOME || join(homedir(), ".grove");
}

/** Expand ~ to home directory */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Cross-platform real path resolution (replaces pwd -P) */
export function realPath(p: string): string {
  return realpathSync(p);
}

/** Cross-platform temp directory */
export function tempDir(): string {
  return tmpdir();
}

/** Whether we're running on Windows */
export const isWindows = platform() === "win32";
