# Batch Planner Design

## Problem

Users with multiple draft tasks for a tree don't know which can run in parallel vs. which will conflict. Manual analysis is tedious; blind parallel dispatch causes rebase-conflict loops (#67).

## Solution: `grove batch <tree>`

A CLI command + API endpoint + GUI button that analyzes draft tasks, predicts file overlap, builds a dependency graph, groups into execution waves, and dispatches on approval.

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/batch/analyze.ts` | Core analysis engine: gather tasks, predict files, build overlap matrix, derive waves |
| `src/batch/types.ts` | Types: `BatchPlan`, `TaskAnalysis`, `OverlapEntry`, `ExecutionWave` |
| `src/cli/commands/batch.ts` | CLI command: `grove batch <tree> [--run] [--json]` |
| `tests/batch/analyze.test.ts` | Unit tests for analysis engine |
| `tests/batch/cli.test.ts` | CLI integration tests |

### Modified Files

| File | Change |
|------|--------|
| `src/cli/index.ts` | Register `batch` command |
| `src/broker/server.ts` | Add `POST /api/batch/analyze` and `POST /api/batch/dispatch` endpoints |
| `web/src/App.tsx` | Add batch plan view |
| `web/src/components/BatchPlan.tsx` (new) | GUI: overlap matrix + wave visualization + dispatch button |

## Flow

### 1. Gather

Collect all draft tasks for the specified tree:

```sql
SELECT * FROM tasks WHERE tree_id = ? AND status = 'draft' ORDER BY priority ASC, created_at ASC
```

### 2. Analyze (file prediction)

For each task, predict which files/modules will be modified. Two strategies:

**Heuristic mode (default, free):**
- Parse task title + description for file/component mentions
- Match against actual files in the tree's repo via glob patterns
- Use keyword matching: e.g., "sidebar" -> `**/Sidebar.*`, "filter" -> `**/filter*`, `**/*Filter*`

**Agent mode (`--agent`, costs tokens):**
- Send task description + tree file listing to Claude
- Get structured JSON response: `{ files: string[], confidence: number }`
- More accurate but costs ~$0.01-0.05 per task

The design uses heuristic mode by default with `--agent` opt-in.

### 3. Overlap Matrix

Build an NxN matrix of task pairs, counting shared predicted files:

```typescript
interface OverlapEntry {
  taskA: string;
  taskB: string;
  sharedFiles: string[];
  overlapCount: number;
}
```

### 4. Dependency Graph

Derive execution order from overlap:
- Tasks with **zero overlap** with all others -> can run in any wave
- Tasks with overlap -> must be sequential (later task depends on earlier by priority)
- Set `depends_on` field for dependent tasks

Algorithm:
1. Build adjacency list from overlap pairs
2. Group independent tasks (no edges between them) into waves
3. Within overlapping clusters, order by priority (lower = first)
4. Result: ordered list of waves, each containing parallelizable task IDs

### 5. Execution Waves

```typescript
interface ExecutionWave {
  wave: number;          // 1-indexed
  taskIds: string[];
  estimatedParallel: boolean;
}

interface BatchPlan {
  treeId: string;
  tasks: TaskAnalysis[];
  overlaps: OverlapEntry[];
  waves: ExecutionWave[];
  totalTasks: number;
}
```

### 6. Present + Execute

**CLI output:**
```
grove batch grove

Analyzing 4 draft tasks for grove...

Predicted file overlap:
  W-025 × W-026: TaskList.tsx, useTasks.ts (2 files)
  W-025 × W-028: TaskList.tsx (1 file)
  W-027 × W-026: Sidebar.tsx (1 file)

Execution waves:
  Wave 1 (parallel): W-028, W-027
    → No predicted file overlap between these two
  Wave 2 (after W-028): W-025
    → Overlaps with W-028 on TaskList.tsx
  Wave 3 (after W-025, W-027): W-026
    → Depends on changes from W-025 and W-027

Dispatch wave 1? (y/n)
```

**API response:** Returns `BatchPlan` JSON for GUI rendering.

**Dispatch:** On approval, set `depends_on` fields and dispatch wave 1 tasks.

## API Endpoints

### `POST /api/batch/analyze`

Request: `{ treeId: string, mode?: "heuristic" | "agent" }`
Response: `BatchPlan`

### `POST /api/batch/dispatch`

Request: `{ treeId: string, wave: number }` (or `{ plan: BatchPlan, wave: number }`)
Response: `{ dispatched: string[], depends_on_set: Record<string, string> }`

Sets `depends_on` for later-wave tasks, then dispatches wave N tasks.

## GUI

A "Plan Batch" button in TaskList header (visible when tree has 2+ draft tasks):
- Opens a modal/panel showing the overlap matrix as a table
- Shows execution waves as grouped task cards
- "Dispatch Wave 1" button at bottom
- Real-time: waves update as tasks complete (wave 2 becomes dispatchable)

## Heuristic File Prediction

The heuristic analyzer extracts likely file paths from task descriptions:

1. **Direct file references:** Regex for paths like `src/foo/bar.ts`, `*.tsx`
2. **Component name matching:** Extract PascalCase/camelCase words, glob for matching files
3. **Keyword expansion:** Map common terms to file patterns:
   - "sidebar" -> `**/Sidebar*`, `**/sidebar*`
   - "filter" -> `**/filter*`, `**/*Filter*`
   - "task list" -> `**/TaskList*`, `**/task-list*`
4. **Fallback:** If no files predicted, treat as potentially overlapping with everything (conservative)

## Testing Strategy

- Unit tests for overlap matrix computation (pure functions, no DB)
- Unit tests for wave derivation (graph algorithm)
- Unit tests for heuristic file prediction
- Integration test: create draft tasks in test DB, run analyze, verify plan
- CLI test: verify output format
