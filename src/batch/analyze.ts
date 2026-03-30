// Grove v3 — Batch planner: analyze draft tasks, predict file overlap, derive execution waves
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Task } from "../shared/types";
import type { TaskAnalysis, OverlapEntry, ExecutionWave, BatchPlan } from "./types";

// ---------------------------------------------------------------------------
// File prediction (heuristic mode)
// ---------------------------------------------------------------------------

/** Walk a repo directory and return all file paths (relative), excluding common junk */
export function listRepoFiles(repoPath: string, maxDepth = 6): string[] {
  const SKIP = new Set([
    "node_modules", ".git", ".grove", "dist", "build", "coverage",
    ".next", ".cache", "__pycache__", ".venv", "vendor",
  ]);
  const files: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        files.push(relative(repoPath, full));
      }
    }
  }

  walk(repoPath, 0);
  return files;
}

/** Extract candidate file patterns from a task's title + description */
export function extractFileHints(title: string, description: string | null): string[] {
  const text = `${title} ${description ?? ""}`;
  const hints: string[] = [];

  // 1. Direct file references: paths like src/foo/bar.ts or *.tsx
  const pathRegex = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|css|html|py|rs|go|md|json|yaml|yml))\b/gi;
  for (const match of text.matchAll(pathRegex)) {
    hints.push(match[1]);
  }

  // 2. PascalCase component names (e.g., TaskList, Sidebar, BatchPlan)
  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  for (const match of text.matchAll(pascalRegex)) {
    hints.push(match[1]);
  }

  // 3. camelCase identifiers (e.g., useTasks, handleClick)
  const camelRegex = /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
  for (const match of text.matchAll(camelRegex)) {
    hints.push(match[1]);
  }

  // 4. Kebab-case / snake_case identifiers (e.g., task-list, step_engine)
  const kebabRegex = /\b([a-z][a-z0-9]*[-_][a-z0-9]+(?:[-_][a-z0-9]+)*)\b/g;
  for (const match of text.matchAll(kebabRegex)) {
    hints.push(match[1]);
  }

  return [...new Set(hints)];
}

/** Match file hints against actual repo files */
export function predictFiles(hints: string[], repoFiles: string[]): string[] {
  const matches = new Set<string>();

  for (const hint of hints) {
    // Direct path match
    if (repoFiles.includes(hint)) {
      matches.add(hint);
      continue;
    }

    // Convert hint to a case-insensitive match pattern
    const lowerHint = hint.toLowerCase();

    // PascalCase/camelCase: match any file containing the name
    for (const file of repoFiles) {
      const lowerFile = file.toLowerCase();
      const basename = lowerFile.split("/").pop() ?? "";

      // Exact basename match (without extension)
      const nameNoExt = basename.replace(/\.[^.]+$/, "");
      if (nameNoExt === lowerHint) {
        matches.add(file);
        continue;
      }

      // Substring match in basename
      if (basename.includes(lowerHint)) {
        matches.add(file);
        continue;
      }

      // Kebab-to-pascal conversion: task-list -> tasklist matches TaskList
      const normalized = lowerHint.replace(/[-_]/g, "");
      if (nameNoExt.replace(/[-_]/g, "") === normalized) {
        matches.add(file);
      }
    }
  }

  return [...matches].sort();
}

/** Analyze a single task to predict which files it will modify */
export function analyzeTask(task: Task, repoFiles: string[]): TaskAnalysis {
  const hints = extractFileHints(task.title, task.description);
  const predictedFiles = predictFiles(hints, repoFiles);

  const confidence: TaskAnalysis["confidence"] =
    predictedFiles.length === 0 ? "low" :
    hints.some(h => repoFiles.includes(h)) ? "high" : "medium";

  return {
    taskId: task.id,
    title: task.title,
    predictedFiles,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Overlap matrix
// ---------------------------------------------------------------------------

/** Build overlap entries for all pairs of analyzed tasks */
export function buildOverlapMatrix(analyses: TaskAnalysis[]): OverlapEntry[] {
  const overlaps: OverlapEntry[] = [];

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const a = analyses[i];
      const b = analyses[j];
      const setA = new Set(a.predictedFiles);
      const shared = b.predictedFiles.filter(f => setA.has(f));

      if (shared.length > 0) {
        overlaps.push({
          taskA: a.taskId,
          taskB: b.taskId,
          sharedFiles: shared.sort(),
        });
      }
    }
  }

  return overlaps;
}

// ---------------------------------------------------------------------------
// Wave derivation (dependency graph → execution waves)
// ---------------------------------------------------------------------------

/** Build adjacency list from overlaps */
function buildAdjacency(taskIds: string[], overlaps: OverlapEntry[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of taskIds) adj.set(id, new Set());

  for (const o of overlaps) {
    adj.get(o.taskA)!.add(o.taskB);
    adj.get(o.taskB)!.add(o.taskA);
  }

  return adj;
}

/**
 * Derive execution waves using greedy graph coloring.
 *
 * Tasks are processed in priority order (lower index = higher priority).
 * Each task is assigned to the earliest wave where none of its overlapping
 * neighbors are already placed. This produces a valid parallel schedule.
 */
export function deriveWaves(analyses: TaskAnalysis[], overlaps: OverlapEntry[]): ExecutionWave[] {
  const taskIds = analyses.map(a => a.taskId);
  if (taskIds.length === 0) return [];

  const adj = buildAdjacency(taskIds, overlaps);

  // Track which wave each task is assigned to
  const waveAssignment = new Map<string, number>();
  // Track which tasks are in each wave
  const waveMembers = new Map<number, string[]>();

  for (const taskId of taskIds) {
    const neighbors = adj.get(taskId)!;

    // Find the earliest wave where no neighbor is placed
    let wave = 1;
    while (true) {
      const members = waveMembers.get(wave) ?? [];
      const conflict = members.some(m => neighbors.has(m));
      if (!conflict) break;
      wave++;
    }

    waveAssignment.set(taskId, wave);
    if (!waveMembers.has(wave)) waveMembers.set(wave, []);
    waveMembers.get(wave)!.push(taskId);
  }

  // Convert to ExecutionWave array, sorted by wave number
  const waves: ExecutionWave[] = [];
  const sortedWaveNums = [...waveMembers.keys()].sort((a, b) => a - b);
  for (const num of sortedWaveNums) {
    waves.push({ wave: num, taskIds: waveMembers.get(num)! });
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Compute depends_on strings from a batch plan's waves */
export function computeDependsOn(waves: ExecutionWave[]): Map<string, string> {
  const result = new Map<string, string>();

  for (let i = 1; i < waves.length; i++) {
    // Tasks in wave i+1 depend on all tasks in wave i
    const prevTaskIds = waves[i - 1].taskIds.join(",");
    for (const taskId of waves[i].taskIds) {
      result.set(taskId, prevTaskIds);
    }
  }

  return result;
}

/** Full batch analysis: gather tasks, predict files, build overlaps, derive waves */
export function analyzeBatch(tasks: Task[], repoPath: string): BatchPlan {
  const repoFiles = listRepoFiles(repoPath);

  const analyses = tasks.map(t => analyzeTask(t, repoFiles));
  const overlaps = buildOverlapMatrix(analyses);
  const waves = deriveWaves(analyses, overlaps);

  return {
    treeId: tasks[0]?.tree_id ?? "",
    tasks: analyses,
    overlaps,
    waves,
  };
}
