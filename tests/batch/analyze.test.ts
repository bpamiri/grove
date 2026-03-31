import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractFileHints,
  predictFiles,
  analyzeTask,
  listRepoFiles,
  buildOverlapMatrix,
  deriveWaves,
  computeDependsOn,
  analyzeBatch,
} from "../../src/batch/analyze";
import type { TaskAnalysis } from "../../src/batch/types";
import type { Task } from "../../src/shared/types";

// ---------------------------------------------------------------------------
// File hint extraction
// ---------------------------------------------------------------------------

describe("extractFileHints", () => {
  test("extracts direct file paths", () => {
    const hints = extractFileHints("Fix bug in src/components/Sidebar.tsx", null);
    expect(hints).toContain("src/components/Sidebar.tsx");
  });

  test("extracts PascalCase component names", () => {
    const hints = extractFileHints("Update the TaskList component", null);
    expect(hints).toContain("TaskList");
  });

  test("extracts camelCase identifiers", () => {
    const hints = extractFileHints("Refactor useTasks hook", null);
    expect(hints).toContain("useTasks");
  });

  test("extracts kebab-case identifiers", () => {
    const hints = extractFileHints("Fix step-engine issue", null);
    expect(hints).toContain("step-engine");
  });

  test("extracts from description too", () => {
    const hints = extractFileHints("Fix sidebar", "The Sidebar.tsx component needs work on useLocalStorage");
    expect(hints).toContain("Sidebar.tsx");
    expect(hints).toContain("useLocalStorage");
  });

  test("deduplicates hints", () => {
    const hints = extractFileHints("TaskList TaskList TaskList", null);
    const taskListCount = hints.filter(h => h === "TaskList").length;
    expect(taskListCount).toBe(1);
  });

  test("returns empty for vague descriptions", () => {
    const hints = extractFileHints("Fix a bug", null);
    expect(hints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// File prediction
// ---------------------------------------------------------------------------

describe("predictFiles", () => {
  const repoFiles = [
    "src/components/Sidebar.tsx",
    "src/components/TaskList.tsx",
    "src/components/TaskDetail.tsx",
    "src/hooks/useTasks.ts",
    "src/hooks/useLocalStorage.ts",
    "src/engine/step-engine.ts",
    "src/batch/analyze.ts",
    "tests/batch/analyze.test.ts",
    "package.json",
    "README.md",
  ];

  test("matches direct file paths", () => {
    const result = predictFiles(["src/components/Sidebar.tsx"], repoFiles);
    expect(result).toEqual(["src/components/Sidebar.tsx"]);
  });

  test("matches PascalCase names to files", () => {
    const result = predictFiles(["TaskList"], repoFiles);
    expect(result).toContain("src/components/TaskList.tsx");
  });

  test("matches camelCase names to files", () => {
    const result = predictFiles(["useTasks"], repoFiles);
    expect(result).toContain("src/hooks/useTasks.ts");
  });

  test("matches kebab-case to actual filenames", () => {
    const result = predictFiles(["step-engine"], repoFiles);
    expect(result).toContain("src/engine/step-engine.ts");
  });

  test("returns empty for unmatched hints", () => {
    const result = predictFiles(["NonExistentFile"], repoFiles);
    expect(result).toEqual([]);
  });

  test("deduplicates matches", () => {
    const result = predictFiles(["Sidebar", "Sidebar.tsx"], repoFiles);
    // Should only contain Sidebar.tsx once
    const sidebarCount = result.filter(f => f.includes("Sidebar")).length;
    expect(sidebarCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Overlap matrix
// ---------------------------------------------------------------------------

describe("buildOverlapMatrix", () => {
  test("detects shared files between tasks", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts", "b.ts"], confidence: "medium" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["b.ts", "c.ts"], confidence: "medium" },
      { taskId: "W-003", title: "Task 3", predictedFiles: ["d.ts"], confidence: "medium" },
    ];

    const overlaps = buildOverlapMatrix(analyses);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].taskA).toBe("W-001");
    expect(overlaps[0].taskB).toBe("W-002");
    expect(overlaps[0].sharedFiles).toEqual(["b.ts"]);
  });

  test("returns empty when no overlaps", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts"], confidence: "medium" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["b.ts"], confidence: "medium" },
    ];

    expect(buildOverlapMatrix(analyses)).toEqual([]);
  });

  test("handles multiple overlapping pairs", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts", "b.ts"], confidence: "medium" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["b.ts", "c.ts"], confidence: "medium" },
      { taskId: "W-003", title: "Task 3", predictedFiles: ["a.ts", "c.ts"], confidence: "medium" },
    ];

    const overlaps = buildOverlapMatrix(analyses);

    // W-001 × W-002 (b.ts), W-001 × W-003 (a.ts), W-002 × W-003 (c.ts)
    expect(overlaps).toHaveLength(3);
  });

  test("handles tasks with no predicted files", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: [], confidence: "low" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["a.ts"], confidence: "medium" },
    ];

    expect(buildOverlapMatrix(analyses)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wave derivation
// ---------------------------------------------------------------------------

describe("deriveWaves", () => {
  test("all independent tasks go in wave 1", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts"], confidence: "medium" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["b.ts"], confidence: "medium" },
      { taskId: "W-003", title: "Task 3", predictedFiles: ["c.ts"], confidence: "medium" },
    ];
    const overlaps = buildOverlapMatrix(analyses); // empty

    const waves = deriveWaves(analyses, overlaps);

    expect(waves).toHaveLength(1);
    expect(waves[0].wave).toBe(1);
    expect(waves[0].taskIds).toEqual(["W-001", "W-002", "W-003"]);
  });

  test("overlapping tasks go in separate waves", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts"], confidence: "medium" },
      { taskId: "W-002", title: "Task 2", predictedFiles: ["a.ts"], confidence: "medium" },
    ];
    const overlaps = buildOverlapMatrix(analyses);

    const waves = deriveWaves(analyses, overlaps);

    expect(waves).toHaveLength(2);
    expect(waves[0].taskIds).toEqual(["W-001"]);
    expect(waves[1].taskIds).toEqual(["W-002"]);
  });

  test("diamond dependency pattern produces correct waves", () => {
    // Reproducing the W-025..W-028 scenario from issue #70
    const analyses: TaskAnalysis[] = [
      { taskId: "W-028", title: "Filter tabs", predictedFiles: ["TaskList.tsx"], confidence: "medium" },
      { taskId: "W-027", title: "Sidebar counts", predictedFiles: ["Sidebar.tsx"], confidence: "medium" },
      { taskId: "W-025", title: "Persistence", predictedFiles: ["TaskList.tsx", "useTasks.ts", "Sidebar.tsx"], confidence: "medium" },
      { taskId: "W-026", title: "Cross-filter", predictedFiles: ["TaskList.tsx", "useTasks.ts", "Sidebar.tsx"], confidence: "medium" },
    ];
    const overlaps = buildOverlapMatrix(analyses);

    const waves = deriveWaves(analyses, overlaps);

    // W-028 and W-027 have no overlap → wave 1
    // W-025 overlaps with W-028 and W-027 → wave 2
    // W-026 overlaps with all three → wave 2 conflicts with W-025 → wave 3
    expect(waves.length).toBeGreaterThanOrEqual(2);

    // W-028 and W-027 should be in wave 1 (no overlap between them)
    expect(waves[0].taskIds).toContain("W-028");
    expect(waves[0].taskIds).toContain("W-027");

    // W-025 and W-026 should be in later waves
    const laterTaskIds = waves.slice(1).flatMap(w => w.taskIds);
    expect(laterTaskIds).toContain("W-025");
    expect(laterTaskIds).toContain("W-026");
  });

  test("returns empty for no tasks", () => {
    expect(deriveWaves([], [])).toEqual([]);
  });

  test("single task goes in wave 1", () => {
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "Task 1", predictedFiles: ["a.ts"], confidence: "medium" },
    ];

    const waves = deriveWaves(analyses, []);
    expect(waves).toHaveLength(1);
    expect(waves[0].taskIds).toEqual(["W-001"]);
  });

  test("chain of overlaps creates sequential waves", () => {
    // A overlaps B, B overlaps C, but A doesn't overlap C
    const analyses: TaskAnalysis[] = [
      { taskId: "W-001", title: "A", predictedFiles: ["a.ts", "shared-ab.ts"], confidence: "medium" },
      { taskId: "W-002", title: "B", predictedFiles: ["shared-ab.ts", "shared-bc.ts"], confidence: "medium" },
      { taskId: "W-003", title: "C", predictedFiles: ["shared-bc.ts", "c.ts"], confidence: "medium" },
    ];
    const overlaps = buildOverlapMatrix(analyses);

    const waves = deriveWaves(analyses, overlaps);

    // A goes to wave 1
    // B overlaps A → wave 2
    // C overlaps B but not A → wave 1 (no conflict with A!)
    expect(waves).toHaveLength(2);
    expect(waves[0].taskIds).toContain("W-001");
    expect(waves[0].taskIds).toContain("W-003");
    expect(waves[1].taskIds).toEqual(["W-002"]);
  });
});

// ---------------------------------------------------------------------------
// Depends-on computation
// ---------------------------------------------------------------------------

describe("computeDependsOn", () => {
  test("wave 2 tasks depend on wave 1", () => {
    const waves = [
      { wave: 1, taskIds: ["W-001", "W-002"] },
      { wave: 2, taskIds: ["W-003"] },
    ];

    const deps = computeDependsOn(waves);
    expect(deps.get("W-003")).toBe("W-001,W-002");
    expect(deps.has("W-001")).toBe(false);
    expect(deps.has("W-002")).toBe(false);
  });

  test("multi-wave chain sets correct dependencies", () => {
    const waves = [
      { wave: 1, taskIds: ["W-001"] },
      { wave: 2, taskIds: ["W-002"] },
      { wave: 3, taskIds: ["W-003"] },
    ];

    const deps = computeDependsOn(waves);
    expect(deps.get("W-002")).toBe("W-001");
    expect(deps.get("W-003")).toBe("W-002");
  });

  test("single wave produces no dependencies", () => {
    const waves = [{ wave: 1, taskIds: ["W-001", "W-002"] }];
    expect(computeDependsOn(waves).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listRepoFiles
// ---------------------------------------------------------------------------

describe("listRepoFiles", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = join(tmpdir(), `grove-batch-test-${Date.now()}`);
    mkdirSync(join(tmpRepo, "src/components"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/hooks"), { recursive: true });
    mkdirSync(join(tmpRepo, "node_modules/foo"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/components/Sidebar.tsx"), "");
    writeFileSync(join(tmpRepo, "src/hooks/useTasks.ts"), "");
    writeFileSync(join(tmpRepo, "package.json"), "{}");
    writeFileSync(join(tmpRepo, "node_modules/foo/index.js"), "");
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  test("lists files excluding node_modules", () => {
    const files = listRepoFiles(tmpRepo);
    expect(files).toContain("src/components/Sidebar.tsx");
    expect(files).toContain("src/hooks/useTasks.ts");
    expect(files).toContain("package.json");
    expect(files.some(f => f.includes("node_modules"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeTask
// ---------------------------------------------------------------------------

describe("analyzeTask", () => {
  const repoFiles = [
    "src/components/TaskList.tsx",
    "src/hooks/useTasks.ts",
    "src/engine/step-engine.ts",
  ];

  const makeTask = (id: string, title: string, desc: string | null = null): Task => ({
    id,
    tree_id: "test",
    parent_task_id: null,
    title,
    description: desc,
    status: "draft",
    current_step: null,
    step_index: 0,
    paused: 0,
    path_name: "development",
    priority: 0,
    depends_on: null,
    branch: null,
    worktree_path: null,
    github_issue: null,
    pr_url: null,
    pr_number: null,
    cost_usd: 0,
    tokens_used: 0,
    gate_results: null,
    session_summary: null,
    files_modified: null,
    retry_count: 0,
    max_retries: 2,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  });

  test("predicts files from task title", () => {
    const result = analyzeTask(makeTask("W-001", "Update the TaskList component"), repoFiles);
    expect(result.predictedFiles).toContain("src/components/TaskList.tsx");
    expect(result.confidence).not.toBe("low");
  });

  test("low confidence when no files matched", () => {
    const result = analyzeTask(makeTask("W-001", "Fix a bug"), repoFiles);
    expect(result.predictedFiles).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  test("high confidence when direct file path matches", () => {
    const result = analyzeTask(
      makeTask("W-001", "Fix src/hooks/useTasks.ts"),
      repoFiles
    );
    expect(result.predictedFiles).toContain("src/hooks/useTasks.ts");
    expect(result.confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Full analyzeBatch integration test
// ---------------------------------------------------------------------------

describe("analyzeBatch", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = join(tmpdir(), `grove-batch-integration-${Date.now()}`);
    mkdirSync(join(tmpRepo, "src/components"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/hooks"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/components/TaskList.tsx"), "export default function TaskList() {}");
    writeFileSync(join(tmpRepo, "src/components/Sidebar.tsx"), "export default function Sidebar() {}");
    writeFileSync(join(tmpRepo, "src/hooks/useTasks.ts"), "export function useTasks() {}");
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  const makeTask = (id: string, title: string, desc: string | null = null): Task => ({
    id,
    tree_id: "test",
    parent_task_id: null,
    title,
    description: desc,
    status: "draft",
    current_step: null,
    step_index: 0,
    paused: 0,
    path_name: "development",
    priority: 0,
    depends_on: null,
    branch: null,
    worktree_path: null,
    github_issue: null,
    pr_url: null,
    pr_number: null,
    cost_usd: 0,
    tokens_used: 0,
    gate_results: null,
    session_summary: null,
    files_modified: null,
    retry_count: 0,
    max_retries: 2,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  });

  test("produces a complete batch plan", async () => {
    const tasks = [
      makeTask("W-001", "Update the TaskList component"),
      makeTask("W-002", "Fix Sidebar navigation"),
      makeTask("W-003", "Refactor useTasks hook and TaskList rendering"),
    ];

    const plan = await analyzeBatch(tasks, tmpRepo);

    expect(plan.treeId).toBe("test");
    expect(plan.tasks).toHaveLength(3);
    expect(plan.waves.length).toBeGreaterThanOrEqual(1);

    // W-001 and W-003 both touch TaskList, so they should overlap
    const overlap = plan.overlaps.find(
      o => (o.taskA === "W-001" && o.taskB === "W-003") ||
           (o.taskA === "W-003" && o.taskB === "W-001")
    );
    expect(overlap).toBeDefined();
    expect(overlap!.sharedFiles.some(f => f.includes("TaskList"))).toBe(true);
  });

  test("non-overlapping tasks all go in wave 1", async () => {
    const tasks = [
      makeTask("W-001", "Update the TaskList component"),
      makeTask("W-002", "Fix Sidebar navigation"),
    ];

    const plan = await analyzeBatch(tasks, tmpRepo);

    // TaskList and Sidebar are separate files — no overlap
    expect(plan.overlaps).toHaveLength(0);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].taskIds).toEqual(["W-001", "W-002"]);
  });
});
