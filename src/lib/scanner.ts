import { readdirSync, readFileSync } from "node:fs";
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
