import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Deep scanning (AI analysis)
// ---------------------------------------------------------------------------

export const DEEP_PROMPTS: Record<string, string> = {
  smells:
    "Identify: dead code, overly complex functions (>50 lines), missing error handling, inconsistent patterns, code duplication.",
  tests:
    "Identify: modules with no test coverage, functions with untested edge cases, missing integration tests.",
  security:
    "Identify: potential vulnerabilities — SQL injection, XSS, hardcoded secrets, unsafe deserialization, command injection, OWASP top 10.",
};

function collectSourceFiles(
  repoPath: string,
): { relPath: string; content: string }[] {
  const files: { relPath: string; content: string }[] = [];
  for (const absPath of walkFiles(repoPath)) {
    try {
      const stat = statSync(absPath);
      if (stat.size > 100_000) continue; // skip files > 100KB
      const content = readFileSync(absPath, "utf-8");
      files.push({ relPath: relative(repoPath, absPath), content });
    } catch {
      continue;
    }
  }
  return files;
}

export function buildDeepPrompt(
  files: { relPath: string; content: string }[],
  categories: string[],
): string {
  const lines: string[] = [
    "Analyze the following source files. For each issue found, return a JSON array.",
    'Each entry: {"file": "path", "line": N, "category": "cat", "title": "short desc", "description": "details"}',
    "",
    "Categories to check:",
  ];

  for (const cat of categories) {
    if (DEEP_PROMPTS[cat]) {
      lines.push(`- ${cat}: ${DEEP_PROMPTS[cat]}`);
    }
  }

  lines.push("", "Source files:");

  for (const f of files) {
    lines.push(`--- FILE: ${f.relPath} ---`);
    lines.push(f.content);
    lines.push("");
  }

  lines.push("Return ONLY a JSON array. No other text.");
  return lines.join("\n");
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

export function parseDeepResponse(response: string, repoName: string): Finding[] {
  try {
    let arr: any;
    try {
      arr = JSON.parse(response);
    } catch {
      // Try extracting JSON array via regex
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) return [];
      arr = JSON.parse(match[0]);
    }

    if (!Array.isArray(arr)) return [];

    return arr.map((entry: any) => ({
      repo: repoName,
      tier: "deep" as const,
      type: entry.category ?? "unknown",
      file: entry.file ?? "",
      line: typeof entry.line === "number" ? entry.line : null,
      title: entry.title ?? "",
      description: entry.description ?? "",
      sourceRef: generateSourceRef(
        "scan",
        repoName,
        "deep",
        entry.category ?? "unknown",
        entry.file ?? "",
        simpleHash(entry.title ?? ""),
      ),
      priority: entry.category === "security" ? 30 : 50,
    }));
  } catch {
    return [];
  }
}

export function scanDeep(
  repoPath: string,
  repoName: string,
  categories: string[],
  limit = 50,
): Finding[] {
  try {
    const sourceFiles = collectSourceFiles(repoPath);
    if (sourceFiles.length === 0) return [];

    // Chunk into ~50KB batches by cumulative content length
    const chunks: { relPath: string; content: string }[][] = [];
    let currentChunk: { relPath: string; content: string }[] = [];
    let currentSize = 0;
    const CHUNK_SIZE = 50_000;

    for (const f of sourceFiles) {
      if (currentSize + f.content.length > CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      currentChunk.push(f);
      currentSize += f.content.length;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allFindings: Finding[] = [];

    for (const chunk of chunks) {
      if (allFindings.length >= limit) break;

      const prompt = buildDeepPrompt(chunk, categories);
      const result = Bun.spawnSync(
        ["claude", "-p", prompt, "--output-format", "json"],
        { cwd: repoPath, timeout: 120_000 },
      );

      const stdout = result.stdout.toString().trim();
      if (!stdout) continue;

      // Claude --output-format json wraps in { result: "..." }
      let responseText = stdout;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.result === "string") {
          responseText = parsed.result;
        }
      } catch {
        // Use raw stdout
      }

      const findings = parseDeepResponse(responseText, repoName);
      allFindings.push(...findings);
    }

    return allFindings.slice(0, limit);
  } catch {
    return [];
  }
}
