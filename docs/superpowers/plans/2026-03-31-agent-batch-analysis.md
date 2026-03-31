# Agent-Powered Batch File Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude-powered file prediction to the batch planner so natural language task descriptions produce accurate overlap analysis.

**Architecture:** A single `claude -p` subprocess call analyzes all draft tasks at once, returning a JSON mapping of task IDs to predicted files. This plugs into the existing `analyzeBatch()` function via the already-parsed `mode` parameter. The downstream pipeline (overlap matrix → waves → dispatch) is unchanged.

**Tech Stack:** Bun (subprocess spawning), Claude Code CLI (`claude -p`), stream-json output parsing

---

### Task 1: Create `agentAnalyzeBatch` in new file

**Files:**
- Create: `src/batch/agent-analyze.ts`
- Test: `tests/batch/agent-analyze.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/batch/agent-analyze.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildAgentPrompt, parseAgentResponse } from "../../src/batch/agent-analyze";
import type { Task } from "../../src/shared/types";

const fakeTasks = [
  { id: "W-001", title: "Fix sidebar navigation", description: "The sidebar nav links don't highlight the current page", tree_id: "repo" },
  { id: "W-002", title: "Add task filtering", description: "Users need to filter tasks by status and tree", tree_id: "repo" },
] as Task[];

const fakeFiles = [
  "src/components/Sidebar.tsx",
  "src/components/TaskList.tsx",
  "src/hooks/useTasks.ts",
  "src/styles/sidebar.css",
  "src/App.tsx",
];

describe("buildAgentPrompt", () => {
  test("includes all task IDs and titles", () => {
    const prompt = buildAgentPrompt(fakeTasks, fakeFiles);
    expect(prompt).toContain("W-001");
    expect(prompt).toContain("W-002");
    expect(prompt).toContain("Fix sidebar navigation");
    expect(prompt).toContain("Add task filtering");
  });

  test("includes repo files", () => {
    const prompt = buildAgentPrompt(fakeTasks, fakeFiles);
    expect(prompt).toContain("src/components/Sidebar.tsx");
    expect(prompt).toContain("src/hooks/useTasks.ts");
  });

  test("truncates file list beyond 500 entries", () => {
    const manyFiles = Array.from({ length: 600 }, (_, i) => `src/file-${i}.ts`);
    const prompt = buildAgentPrompt(fakeTasks, manyFiles);
    // Should contain truncation notice
    expect(prompt).toContain("truncated");
    // Should not contain all 600 files
    expect(prompt.split("\n").length).toBeLessThan(650);
  });
});

describe("parseAgentResponse", () => {
  test("parses valid JSON mapping", () => {
    const response = JSON.stringify({
      "W-001": ["src/components/Sidebar.tsx", "src/styles/sidebar.css"],
      "W-002": ["src/components/TaskList.tsx", "src/hooks/useTasks.ts"],
    });
    const result = parseAgentResponse(response, fakeTasks, fakeFiles);
    expect(result.length).toBe(2);
    expect(result[0].taskId).toBe("W-001");
    expect(result[0].predictedFiles).toContain("src/components/Sidebar.tsx");
    expect(result[0].confidence).toBe("high");
    expect(result[1].taskId).toBe("W-002");
  });

  test("filters out files not in repo", () => {
    const response = JSON.stringify({
      "W-001": ["src/components/Sidebar.tsx", "src/nonexistent/Fake.ts"],
    });
    const result = parseAgentResponse(response, fakeTasks, fakeFiles);
    expect(result[0].predictedFiles).toEqual(["src/components/Sidebar.tsx"]);
    expect(result[0].predictedFiles).not.toContain("src/nonexistent/Fake.ts");
  });

  test("returns empty predictions for tasks missing from response", () => {
    const response = JSON.stringify({
      "W-001": ["src/components/Sidebar.tsx"],
    });
    const result = parseAgentResponse(response, fakeTasks, fakeFiles);
    expect(result.length).toBe(2);
    expect(result[1].taskId).toBe("W-002");
    expect(result[1].predictedFiles).toEqual([]);
    expect(result[1].confidence).toBe("low");
  });

  test("handles JSON embedded in markdown code block", () => {
    const response = "Here are my predictions:\n```json\n" + JSON.stringify({
      "W-001": ["src/components/Sidebar.tsx"],
      "W-002": ["src/components/TaskList.tsx"],
    }) + "\n```";
    const result = parseAgentResponse(response, fakeTasks, fakeFiles);
    expect(result.length).toBe(2);
    expect(result[0].predictedFiles).toContain("src/components/Sidebar.tsx");
  });

  test("returns all-low-confidence on unparseable response", () => {
    const result = parseAgentResponse("This is not JSON at all", fakeTasks, fakeFiles);
    expect(result.length).toBe(2);
    expect(result.every(r => r.confidence === "low")).toBe(true);
    expect(result.every(r => r.predictedFiles.length === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/batch/agent-analyze.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `agent-analyze.ts`**

Create `src/batch/agent-analyze.ts`:

```typescript
// Grove v3 — Agent-powered batch file prediction via Claude Code subprocess
import type { Task } from "../shared/types";
import type { TaskAnalysis } from "./types";

const MAX_FILES_IN_PROMPT = 500;

/** Build the prompt for Claude to predict file modifications for a batch of tasks */
export function buildAgentPrompt(tasks: Task[], repoFiles: string[]): string {
  const taskList = tasks.map((t, i) =>
    `${i + 1}. ${t.id}: "${t.title}"${t.description ? ` — ${t.description.slice(0, 300)}` : ""}`
  ).join("\n");

  let fileList: string;
  if (repoFiles.length > MAX_FILES_IN_PROMPT) {
    fileList = repoFiles.slice(0, MAX_FILES_IN_PROMPT).join("\n") +
      `\n\n(${repoFiles.length - MAX_FILES_IN_PROMPT} more files truncated)`;
  } else {
    fileList = repoFiles.join("\n");
  }

  return `You are analyzing development tasks for a codebase. For each task, predict which files will likely be modified during implementation.

Here are the tasks:

${taskList}

Here are the files in the repository:
${fileList}

For each task, return a JSON object mapping task IDs to arrays of predicted file paths. Only include files from the repository list above. Return ONLY the JSON object, no other text.

Example format:
{
  "${tasks[0]?.id ?? "W-001"}": ["path/to/file1.ts", "path/to/file2.ts"],
  "${tasks[1]?.id ?? "W-002"}": ["path/to/file3.ts"]
}`;
}

/** Parse Claude's response text into TaskAnalysis array */
export function parseAgentResponse(
  responseText: string,
  tasks: Task[],
  repoFiles: string[],
): TaskAnalysis[] {
  const repoFileSet = new Set(repoFiles);
  let parsed: Record<string, string[]> | null = null;

  // Try direct JSON parse first
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    // Try extracting JSON from markdown code block
    const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } catch { /* fall through */ }
    }
  }

  // If still unparseable, try finding first { ... } block
  if (!parsed) {
    const braceMatch = responseText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        parsed = JSON.parse(braceMatch[0]);
      } catch { /* fall through */ }
    }
  }

  return tasks.map(task => {
    const predicted = parsed?.[task.id];
    if (!predicted || !Array.isArray(predicted)) {
      return { taskId: task.id, title: task.title, predictedFiles: [], confidence: "low" as const };
    }

    // Filter to only files that exist in the repo
    const validFiles = predicted.filter(f => repoFileSet.has(f));

    return {
      taskId: task.id,
      title: task.title,
      predictedFiles: validFiles.sort(),
      confidence: validFiles.length > 0 ? "high" as const : "low" as const,
    };
  });
}

/** Spawn Claude Code to analyze tasks and return file predictions */
export async function agentAnalyzeBatch(
  tasks: Task[],
  repoFiles: string[],
): Promise<TaskAnalysis[]> {
  const prompt = buildAgentPrompt(tasks, repoFiles);

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe" },
  );

  // Collect all stdout
  const chunks: string[] = [];
  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  const exitCode = await proc.exited;
  const output = chunks.join("");

  if (exitCode !== 0) {
    throw new Error(`Claude process exited with code ${exitCode}`);
  }

  // Parse stream-json output: find the last "assistant" message with text content
  let responseText = "";
  for (const line of output.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant") {
        for (const block of obj.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            responseText = block.text;
          }
        }
      }
      // Also check "result" type which has the final text
      if (obj.type === "result") {
        for (const block of obj.result?.content ?? obj.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            responseText = block.text;
          }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }

  if (!responseText) {
    throw new Error("No text response from Claude");
  }

  return parseAgentResponse(responseText, tasks, repoFiles);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/batch/agent-analyze.test.ts`
Expected: PASS (7 tests — the prompt and parse tests; `agentAnalyzeBatch` itself isn't unit-tested since it spawns a real process)

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/batch/agent-analyze.ts tests/batch/agent-analyze.test.ts
git commit -m "feat: add agent-powered batch file prediction via Claude subprocess (#70, #86)"
```

---

### Task 2: Wire agent mode into `analyzeBatch`

**Files:**
- Modify: `src/batch/analyze.ts:239-253` (the `analyzeBatch` function)

- [ ] **Step 1: Update `analyzeBatch` to accept mode and call agent path**

Replace the `analyzeBatch` function at the end of `src/batch/analyze.ts`:

```typescript
/** Full batch analysis: gather tasks, predict files, build overlaps, derive waves */
export async function analyzeBatch(
  tasks: Task[],
  repoPath: string,
  mode: "heuristic" | "agent" | "hybrid" = "heuristic",
): Promise<BatchPlan> {
  const repoFiles = listRepoFiles(repoPath);

  let analyses: TaskAnalysis[];

  if (mode === "agent") {
    const { agentAnalyzeBatch } = await import("./agent-analyze");
    try {
      analyses = await agentAnalyzeBatch(tasks, repoFiles);
    } catch (err) {
      // Fall back to heuristic on agent failure
      console.error(`[batch] Agent analysis failed, falling back to heuristic:`, err);
      analyses = tasks.map(t => analyzeTask(t, repoFiles));
    }
  } else if (mode === "hybrid") {
    // Heuristic first
    analyses = tasks.map(t => analyzeTask(t, repoFiles));
    const lowConfidence = analyses.filter(a => a.confidence === "low");

    if (lowConfidence.length > 0) {
      // Re-analyze low-confidence tasks with agent
      const lowTasks = tasks.filter(t => lowConfidence.some(a => a.taskId === t.id));
      try {
        const { agentAnalyzeBatch } = await import("./agent-analyze");
        const agentResults = await agentAnalyzeBatch(lowTasks, repoFiles);
        // Merge: replace low-confidence entries with agent results
        const agentMap = new Map(agentResults.map(a => [a.taskId, a]));
        analyses = analyses.map(a => agentMap.get(a.taskId) ?? a);
      } catch (err) {
        console.error(`[batch] Agent fallback failed, using heuristic results:`, err);
      }
    }
  } else {
    analyses = tasks.map(t => analyzeTask(t, repoFiles));
  }

  const overlaps = buildOverlapMatrix(analyses);
  const waves = deriveWaves(analyses, overlaps);

  return {
    treeId: tasks[0]?.tree_id ?? "",
    tasks: analyses,
    overlaps,
    waves,
  };
}
```

- [ ] **Step 2: Update callers to await**

In `src/broker/server.ts`, find the two places that call `analyzeBatch` (around lines 1142 and 1166). Both already use `await import()` so just add `await` to the calls and pass the mode.

Find the `POST /api/batch/analyze` handler (around line 1125):

```typescript
    // POST /api/batch/analyze — analyze draft tasks for a tree and produce a batch plan
    if (path === "/api/batch/analyze" && req.method === "POST") {
      const body = await req.json() as { treeId: string; mode?: "heuristic" | "agent" | "hybrid" };
      if (!body.treeId) return json({ error: "treeId required" }, 400);

      const tree = db.treeGet(body.treeId);
      if (!tree) return json({ error: `Tree "${body.treeId}" not found` }, 404);

      const drafts = db.all<any>(
        "SELECT * FROM tasks WHERE tree_id = ? AND status = 'draft' ORDER BY priority ASC, created_at ASC",
        [body.treeId]
      );

      if (drafts.length === 0) {
        return json({ treeId: body.treeId, tasks: [], overlaps: [], waves: [] });
      }

      const { analyzeBatch } = await import("../batch/analyze");
      const plan = await analyzeBatch(drafts, tree.path, body.mode);
      return json(plan);
    }
```

The key change is: `analyzeBatch(drafts, tree.path)` → `await analyzeBatch(drafts, tree.path, body.mode)`.

Find the `POST /api/batch/dispatch` handler (around line 1147) and make the same change:

```typescript
      const { analyzeBatch, computeDependsOn } = await import("../batch/analyze");
      const plan = await analyzeBatch(drafts, tree.path);
```

Change to:

```typescript
      const { analyzeBatch, computeDependsOn } = await import("../batch/analyze");
      const plan = await analyzeBatch(drafts, tree.path);
```

(Dispatch always uses heuristic — no mode param needed since the default is "heuristic".)

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass. Existing `analyzeBatch` tests in `tests/batch/analyze.test.ts` may need updating since the function is now async — add `await` to the call in the integration test.

- [ ] **Step 4: Fix any test that calls `analyzeBatch` synchronously**

In `tests/batch/analyze.test.ts`, find the integration test that calls `analyzeBatch` and add `async`/`await`:

```typescript
// Change from:
test("full batch analysis integration", () => {
  const plan = analyzeBatch(tasks, tmpDir);
// To:
test("full batch analysis integration", async () => {
  const plan = await analyzeBatch(tasks, tmpDir);
```

- [ ] **Step 5: Run tests again to confirm**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/batch/analyze.ts src/broker/server.ts tests/batch/analyze.test.ts
git commit -m "feat: wire agent and hybrid modes into analyzeBatch (#70, #86)"
```

---

### Task 3: Add `--agent` and `--hybrid` flags to CLI

**Files:**
- Modify: `src/cli/commands/batch.ts`

- [ ] **Step 1: Add flag parsing and pass mode to API**

In `src/cli/commands/batch.ts`, update the arg parsing to include `--agent` and `--hybrid`, and pass the mode in the API request.

Replace the arg parsing block (lines 12-29) and the API call (line 42-46):

```typescript
  // Parse args: grove batch <tree> [--run] [--json] [--agent] [--hybrid]
  let treeId: string | null = null;
  let autoRun = false;
  let jsonOutput = false;
  let mode: "heuristic" | "agent" | "hybrid" = "heuristic";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run") {
      autoRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--agent") {
      mode = "agent";
    } else if (arg === "--hybrid") {
      mode = "hybrid";
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    } else if (!arg.startsWith("-")) {
      treeId = arg;
    }
  }
```

Update the usage line:

```typescript
  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove batch <tree> [--run] [--json] [--agent] [--hybrid]`);
    console.log(`\nRun ${pc.bold("grove batch --help")} for details.`);
    return;
  }
```

Update the analyzing message to show mode:

```typescript
    const modeLabel = mode === "agent" ? " (AI analysis)" : mode === "hybrid" ? " (hybrid analysis)" : "";
    console.log(`${pc.dim("Analyzing draft tasks for")} ${pc.bold(treeId)}${pc.dim(modeLabel + "...")}`);
```

Update the API call to pass mode:

```typescript
    const resp = await fetch(`${info.url}/api/batch/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ treeId, mode }),
    });
```

- [ ] **Step 2: Update the help text**

Replace the `printHelp` function:

```typescript
function printHelp() {
  console.log(`Usage: grove batch <tree> [--run] [--json] [--agent] [--hybrid]

Analyze draft tasks for a tree, predict file overlap, and plan execution waves.

What it does:
  1. Gathers all draft tasks for the specified tree
  2. Predicts which files each task will modify
  3. Builds an overlap matrix of shared file predictions
  4. Derives execution waves (conflict-free parallel groups)
  5. Shows the plan and optionally dispatches wave 1

Analysis modes:
  (default)   Heuristic — regex-based file prediction (free, instant)
  --agent     AI-assisted — Claude analyzes all tasks (accurate, ~$0.01-0.05)
  --hybrid    Heuristic first, AI fallback for low-confidence tasks

Options:
  --run     Analyze and auto-dispatch wave 1
  --json    Output the batch plan as JSON
  --help    Show this help

Examples:
  grove batch grove              Analyze with heuristic (default)
  grove batch grove --agent      Analyze with AI
  grove batch grove --hybrid     Heuristic + AI fallback
  grove batch grove --agent --run  AI analysis + dispatch wave 1`);
}
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/batch.ts
git commit -m "feat: add --agent and --hybrid flags to grove batch CLI (#70, #86)"
```

---

### Task 4: Add mode toggle to web UI

**Files:**
- Modify: `web/src/components/BatchPlan.tsx`

- [ ] **Step 1: Add mode state and toggle UI**

In `web/src/components/BatchPlan.tsx`, add mode state after the existing state declarations (around line 46):

```typescript
  const [mode, setMode] = useState<"heuristic" | "agent" | "hybrid">("heuristic");
```

Update the `analyze` callback to pass mode:

```typescript
  const analyze = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Plan>("/api/batch/analyze", {
        method: "POST",
        body: JSON.stringify({ treeId, mode }),
      });
      setPlan(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [treeId, mode]);
```

Add a mode toggle next to the "Analyze Draft Tasks" button. Find the analyze button block (`{!plan && !loading && (`) and replace it with:

```tsx
      {!plan && !loading && (
        <div className="space-y-2">
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setMode("heuristic")}
              className={`px-2 py-1 rounded ${mode === "heuristic" ? "bg-zinc-600 text-zinc-200" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              Fast
            </button>
            <button
              onClick={() => setMode("hybrid")}
              className={`px-2 py-1 rounded ${mode === "hybrid" ? "bg-zinc-600 text-zinc-200" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              Hybrid
            </button>
            <button
              onClick={() => setMode("agent")}
              className={`px-2 py-1 rounded ${mode === "agent" ? "bg-emerald-500/30 text-emerald-400" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
            >
              AI-Assisted
            </button>
          </div>
          <button
            onClick={analyze}
            className="w-full bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg hover:bg-emerald-500/30 text-sm font-medium"
          >
            Analyze Draft Tasks
          </button>
        </div>
      )}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add web/src/components/BatchPlan.tsx
git commit -m "feat: add analysis mode toggle to batch planner UI (#70, #86)"
```
