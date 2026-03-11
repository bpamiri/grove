import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Finding {
  repo: string;
  tier: "marker" | "signal" | "deep";
  type: string;
  file: string;
  line: number | null;
  title: string;
  description: string;
  sourceRef: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_RE = /\b(TODO|FIXME|HACK|XXX|DEPRECATED)\s*:\s*(.*)/i;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "coverage",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".bz2",
  ".pdf", ".bin", ".exe", ".so", ".dylib", ".dll",
  ".mp3", ".mp4", ".wav", ".mov",
  ".sqlite", ".db",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateSourceRef(...parts: string[]): string {
  return parts.join(":");
}

function* walkFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walkFiles(join(dir, entry.name));
    } else if (entry.isFile()) {
      if (BINARY_EXTS.has(extname(entry.name).toLowerCase())) continue;
      yield join(dir, entry.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export function scanMarkers(repoPath: string, repoName: string, limit = 50): Finding[] {
  const findings: Finding[] = [];
  const files = walkFiles(repoPath);

  for (const absPath of files) {
    if (findings.length >= limit) break;

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (findings.length >= limit) break;

      const match = lines[i].match(MARKER_RE);
      if (!match) continue;

      const marker = match[1].toUpperCase();
      const text = match[2].trim();
      const relFile = relative(repoPath, absPath);
      const lineNum = i + 1;

      findings.push({
        repo: repoName,
        tier: "marker",
        type: marker,
        file: relFile,
        line: lineNum,
        title: `${marker}: ${text}`,
        description: text,
        sourceRef: generateSourceRef("scan", repoName, relFile, String(lineNum), marker),
        priority: 50,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Toolchain detection
// ---------------------------------------------------------------------------

export interface Toolchain {
  runtime: "bun" | "node" | "python" | null;
  hasLint: boolean;
  lintTool: string | null;
}

export function detectToolchain(repoPath: string): Toolchain {
  let runtime: Toolchain["runtime"] = null;
  let hasLint = false;
  let lintTool: string | null = null;

  // Runtime detection
  if (
    existsSync(join(repoPath, "bunfig.toml")) ||
    existsSync(join(repoPath, "bun.lockb")) ||
    existsSync(join(repoPath, "bun.lock"))
  ) {
    runtime = "bun";
  } else if (existsSync(join(repoPath, "package.json"))) {
    runtime = "node";
  } else if (
    existsSync(join(repoPath, "pyproject.toml")) ||
    existsSync(join(repoPath, "setup.py"))
  ) {
    runtime = "python";
  }

  // Lint detection
  if (
    existsSync(join(repoPath, ".eslintrc.json")) ||
    existsSync(join(repoPath, ".eslintrc.js")) ||
    existsSync(join(repoPath, ".eslintrc.yml")) ||
    existsSync(join(repoPath, "eslint.config.js")) ||
    existsSync(join(repoPath, "eslint.config.mjs")) ||
    existsSync(join(repoPath, "eslint.config.ts"))
  ) {
    hasLint = true;
    lintTool = "eslint";
  } else if (existsSync(join(repoPath, "ruff.toml"))) {
    hasLint = true;
    lintTool = "ruff";
  }

  return { runtime, hasLint, lintTool };
}

// ---------------------------------------------------------------------------
// Signal scanning
// ---------------------------------------------------------------------------

export function parseNpmOutdated(jsonStr: string): { pkg: string; current: string; latest: string }[] {
  const data = JSON.parse(jsonStr) as Record<string, { current: string; latest: string }>;
  const results: { pkg: string; current: string; latest: string }[] = [];

  for (const [pkg, info] of Object.entries(data)) {
    if (!info.current || !info.latest) continue;
    const currentMajor = parseInt(info.current.split(".")[0], 10);
    const latestMajor = parseInt(info.latest.split(".")[0], 10);
    if (isNaN(currentMajor) || isNaN(latestMajor)) continue;
    if (currentMajor !== latestMajor) {
      results.push({ pkg, current: info.current, latest: info.latest });
    }
  }

  return results;
}

export function scanSignals(repoPath: string, repoName: string, limit = 50): Finding[] {
  try {
    const toolchain = detectToolchain(repoPath);
    if (toolchain.runtime !== "bun" && toolchain.runtime !== "node") {
      return [];
    }

    const findings: Finding[] = [];

    try {
      const result = Bun.spawnSync(["npm", "outdated", "--json"], {
        cwd: repoPath,
        timeout: 30_000,
      });

      const stdout = result.stdout.toString().trim();
      if (result.exitCode > 0 && stdout.length > 0) {
        const outdated = parseNpmOutdated(stdout);
        for (const { pkg, current, latest } of outdated) {
          if (findings.length >= limit) break;
          findings.push({
            repo: repoName,
            tier: "signal",
            type: "outdep",
            file: "package.json",
            line: null,
            title: `Outdated: ${pkg} ${current} \u2192 ${latest}`,
            description: `${pkg} ${current} \u2192 ${latest}`,
            sourceRef: generateSourceRef("scan", repoName, "signal", "outdep", pkg),
            priority: 50,
          });
        }
      }
    } catch {
      // Command failure is non-fatal
    }

    return findings;
  } catch {
    return [];
  }
}
