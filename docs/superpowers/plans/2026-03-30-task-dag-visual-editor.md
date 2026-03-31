# T7: Task Dependency DAG + Visual Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proper dependency DAG with cycle detection, topological dispatch, and a visual graph editor in the GUI using ReactFlow.

**Architecture:** Pure-function DAG algorithms (cycle detection, topo sort, ready tasks) in `src/batch/dag.ts`. A `task_edges` table replaces comma-separated `depends_on` for explicit dependency storage. Dispatch uses DAG-aware ordering. The GUI gets a ReactFlow-based DAG editor.

**Tech Stack:** Bun, TypeScript, ReactFlow (@xyflow/react), dagre (auto-layout)

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T7 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/batch/dag.ts` | DAG algorithms: cycle detection, topo sort, ready tasks |
| Create | `tests/batch/dag.test.ts` | DAG algorithm tests |
| Modify | `src/broker/schema-sql.ts` | Add task_edges table |
| Modify | `src/broker/db.ts` | Edge CRUD, migration from depends_on |
| Modify | `src/broker/dispatch.ts` | DAG-aware dispatch ordering |
| Modify | `src/broker/server.ts` | DAG API endpoints |
| Create | `web/src/components/DagEditor.tsx` | ReactFlow visual editor |
| Modify | `web/src/App.tsx` | Add DAG view |

---

### Task 1: DAG Algorithms

**Files:** Create `src/batch/dag.ts`, `tests/batch/dag.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/batch/dag.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { detectCycle, topoSort, readyTasks, type DagEdge } from "../../src/batch/dag";

describe("detectCycle", () => {
  test("returns null for acyclic graph", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    expect(detectCycle(["A", "B", "C"], edges)).toBeNull();
  });

  test("detects simple cycle", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ];
    const cycle = detectCycle(["A", "B"], edges);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(0);
  });

  test("detects cycle in larger graph", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ];
    expect(detectCycle(["A", "B", "C"], edges)).not.toBeNull();
  });

  test("returns null for empty graph", () => {
    expect(detectCycle([], [])).toBeNull();
  });

  test("returns null for disconnected nodes", () => {
    expect(detectCycle(["A", "B", "C"], [])).toBeNull();
  });
});

describe("topoSort", () => {
  test("sorts linear chain", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    const sorted = topoSort(["A", "B", "C"], edges);
    expect(sorted.indexOf("A")).toBeLessThan(sorted.indexOf("B"));
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("C"));
  });

  test("sorts diamond dependency", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];
    const sorted = topoSort(["A", "B", "C", "D"], edges);
    expect(sorted.indexOf("A")).toBeLessThan(sorted.indexOf("B"));
    expect(sorted.indexOf("A")).toBeLessThan(sorted.indexOf("C"));
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("D"));
    expect(sorted.indexOf("C")).toBeLessThan(sorted.indexOf("D"));
  });

  test("includes disconnected nodes", () => {
    const sorted = topoSort(["A", "B", "C"], []);
    expect(sorted.length).toBe(3);
  });

  test("throws on cycle", () => {
    const edges: DagEdge[] = [{ from: "A", to: "B" }, { from: "B", to: "A" }];
    expect(() => topoSort(["A", "B"], edges)).toThrow();
  });
});

describe("readyTasks", () => {
  test("returns tasks with all deps completed", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
    ];
    const completed = new Set(["A"]);
    const ready = readyTasks(["A", "B", "C"], edges, completed);
    expect(ready).toContain("B");
    expect(ready).toContain("C");
    expect(ready).not.toContain("A");
  });

  test("blocks tasks with incomplete deps", () => {
    const edges: DagEdge[] = [
      { from: "A", to: "C" },
      { from: "B", to: "C" },
    ];
    const completed = new Set(["A"]);
    const ready = readyTasks(["A", "B", "C"], edges, completed);
    expect(ready).toContain("B"); // no deps
    expect(ready).not.toContain("C"); // B not done
  });

  test("returns all nodes when no edges", () => {
    const ready = readyTasks(["A", "B", "C"], [], new Set());
    expect(ready.length).toBe(3);
  });

  test("excludes completed tasks", () => {
    const ready = readyTasks(["A", "B"], [], new Set(["A"]));
    expect(ready).toContain("B");
    expect(ready).not.toContain("A");
  });
});
```

- [ ] **Step 2: Implement DAG algorithms**

Create `src/batch/dag.ts`:

```typescript
// Grove v3 — DAG algorithms for task dependency management

export interface DagEdge {
  from: string;  // dependency (must complete first)
  to: string;    // dependent (waits for from)
}

/** Detect cycle using DFS 3-color algorithm. Returns cycle path or null. */
export function detectCycle(nodeIds: string[], edges: DagEdge[]): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    color.set(id, WHITE);
    adj.set(id, []);
  }
  for (const { from, to } of edges) {
    adj.get(from)?.push(to);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) {
      const cycle = dfs(id, color, parent, adj);
      if (cycle) return cycle;
    }
  }
  return null;
}

function dfs(
  node: string,
  color: Map<string, number>,
  parent: Map<string, string>,
  adj: Map<string, string[]>,
): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  color.set(node, GRAY);

  for (const neighbor of adj.get(node) ?? []) {
    if (color.get(neighbor) === GRAY) {
      // Found cycle — reconstruct path
      const cycle = [neighbor, node];
      return cycle;
    }
    if (color.get(neighbor) === WHITE) {
      parent.set(neighbor, node);
      const result = dfs(neighbor, color, parent, adj);
      if (result) return result;
    }
  }

  color.set(node, BLACK);
  return null;
}

/** Topological sort using Kahn's algorithm. Throws if cycle detected. */
export function topoSort(nodeIds: string[], edges: DagEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const { from, to } of edges) {
    adj.get(from)?.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodeIds.length) {
    throw new Error("Cycle detected — cannot topologically sort");
  }

  return sorted;
}

/** Get tasks that are not completed and have all dependencies satisfied. */
export function readyTasks(nodeIds: string[], edges: DagEdge[], completedIds: Set<string>): string[] {
  return nodeIds.filter(id => {
    if (completedIds.has(id)) return false;
    const deps = edges.filter(e => e.to === id).map(e => e.from);
    return deps.every(d => completedIds.has(d));
  });
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/batch/dag.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/batch/dag.ts tests/batch/dag.test.ts
git commit -m "feat: add DAG algorithms — cycle detection, topological sort, ready tasks"
```

---

### Task 2: Task Edges Schema + DB Methods

**Files:** Modify `src/broker/schema-sql.ts`, `src/broker/db.ts`

- [ ] **Step 1: Add task_edges table to schema**

In `src/broker/schema-sql.ts`, add after the tasks table (before the sessions table):

```sql
CREATE TABLE IF NOT EXISTS task_edges (
  from_task TEXT NOT NULL REFERENCES tasks(id),
  to_task TEXT NOT NULL REFERENCES tasks(id),
  edge_type TEXT NOT NULL DEFAULT 'dependency',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_task, to_task)
);
CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges(to_task);
```

- [ ] **Step 2: Add edge CRUD methods to db.ts**

In `src/broker/db.ts`, add methods:

```typescript
  addEdge(fromTask: string, toTask: string, edgeType: string = "dependency"): void {
    this.run(
      "INSERT OR IGNORE INTO task_edges (from_task, to_task, edge_type) VALUES (?, ?, ?)",
      [fromTask, toTask, edgeType],
    );
  }

  removeEdge(fromTask: string, toTask: string): void {
    this.run("DELETE FROM task_edges WHERE from_task = ? AND to_task = ?", [fromTask, toTask]);
  }

  allTaskEdges(): Array<{ from_task: string; to_task: string; edge_type: string }> {
    return this.all("SELECT from_task, to_task, edge_type FROM task_edges");
  }

  taskEdgesFor(taskId: string): Array<{ from_task: string; to_task: string; edge_type: string }> {
    return this.all(
      "SELECT from_task, to_task, edge_type FROM task_edges WHERE from_task = ? OR to_task = ?",
      [taskId, taskId],
    );
  }

  /** Migrate existing depends_on strings to task_edges (run once on startup) */
  migrateDepends(): void {
    const tasks = this.all<{ id: string; depends_on: string }>(
      "SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL AND depends_on != ''",
    );
    for (const task of tasks) {
      for (const dep of task.depends_on.split(",").map(s => s.trim()).filter(Boolean)) {
        this.addEdge(dep, task.id);
      }
    }
  }
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/broker/schema-sql.ts src/broker/db.ts
git commit -m "feat: add task_edges table and edge CRUD methods"
```

---

### Task 3: DAG-Aware Dispatch

**Files:** Modify `src/broker/dispatch.ts`

- [ ] **Step 1: Use DAG readyTasks in dispatch queue**

In `src/broker/dispatch.ts`, add import:
```typescript
import { readyTasks, type DagEdge } from "../batch/dag";
```

In the dispatch loop where tasks are checked for blocking, replace the `db.isTaskBlocked(taskId)` check with DAG-aware readiness. Find the section that processes the pending queue and update it:

The key change: instead of checking `isTaskBlocked()` per-task in a linear queue, compute the full set of ready tasks from the DAG and only dispatch those.

In the `processQueue` function (or equivalent), before iterating:

```typescript
  // Compute DAG-ready tasks
  const edges = db.allTaskEdges().map(e => ({ from: e.from_task, to: e.to_task } as DagEdge));
  const completedIds = new Set(
    db.all<{ id: string }>("SELECT id FROM tasks WHERE status = 'completed'").map(t => t.id),
  );
```

Then when checking if a task can be dispatched, use:
```typescript
  const dagReady = new Set(readyTasks(pendingQueue, edges, completedIds));
  // Only dispatch tasks that are DAG-ready
  if (!dagReady.has(taskId)) {
    // Skip, try again later
    continue;
  }
```

Keep the existing `isTaskBlocked` as a fallback for the comma-separated `depends_on` field (backward compat).

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/broker/dispatch.ts
git commit -m "feat: use DAG-aware ordering in dispatch queue"
```

---

### Task 4: DAG API Endpoints

**Files:** Modify `src/broker/server.ts`

- [ ] **Step 1: Add DAG endpoints**

In `src/broker/server.ts`, add import:
```typescript
import { detectCycle, type DagEdge } from "../batch/dag";
```

Add endpoints in handleApi before the fallback 404:

```typescript
    // GET /api/tasks/dag — full DAG (nodes + edges)
    if (path === "/api/tasks/dag" && req.method === "GET") {
      const tasks = db.all<{ id: string; title: string; status: string }>(
        "SELECT id, title, status FROM tasks ORDER BY created_at DESC",
      );
      const edges = db.allTaskEdges();
      return json({ nodes: tasks, edges });
    }

    // POST /api/tasks/edges — add dependency edge
    if (path === "/api/tasks/edges" && req.method === "POST") {
      const body = await req.json() as any;
      const { from, to, type } = body;
      if (!from || !to) return json({ error: "Missing from or to" }, 400);

      // Check for cycle before adding
      const existingEdges = db.allTaskEdges().map(e => ({ from: e.from_task, to: e.to_task } as DagEdge));
      existingEdges.push({ from, to });
      const allIds = new Set([...existingEdges.map(e => e.from), ...existingEdges.map(e => e.to)]);
      const cycle = detectCycle([...allIds], existingEdges);
      if (cycle) return json({ error: "Would create a cycle", cycle }, 400);

      db.addEdge(from, to, type ?? "dependency");
      return json({ ok: true });
    }

    // DELETE /api/tasks/edges — remove dependency edge
    const edgeDeleteMatch = path.match(/^\/api\/tasks\/edges\/([^/]+)\/([^/]+)$/);
    if (edgeDeleteMatch && req.method === "DELETE") {
      db.removeEdge(edgeDeleteMatch[1], edgeDeleteMatch[2]);
      return json({ ok: true });
    }

    // POST /api/tasks/dag/validate — check for cycles
    if (path === "/api/tasks/dag/validate" && req.method === "POST") {
      const edges = db.allTaskEdges().map(e => ({ from: e.from_task, to: e.to_task } as DagEdge));
      const allIds = new Set([...edges.map(e => e.from), ...edges.map(e => e.to)]);
      const cycle = detectCycle([...allIds], edges);
      return json({ valid: !cycle, cycle });
    }
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: add DAG API endpoints with cycle detection"
```

---

### Task 5: ReactFlow DAG Editor

**Files:** Modify `web/package.json`, Create `web/src/components/DagEditor.tsx`, Modify `web/src/App.tsx`

- [ ] **Step 1: Install ReactFlow**

```bash
cd web && bun add @xyflow/react
```

- [ ] **Step 2: Create DagEditor component**

Create `web/src/components/DagEditor.tsx`:

```tsx
import { useCallback, useEffect, useState, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api/client";

interface DagData {
  nodes: Array<{ id: string; title: string; status: string }>;
  edges: Array<{ from_task: string; to_task: string; edge_type: string }>;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#52525b",
  queued: "#3b82f6",
  active: "#eab308",
  completed: "#22c55e",
  failed: "#ef4444",
};

export default function DagEditor({ onSelectTask }: { onSelectTask?: (id: string) => void }) {
  const [dagData, setDagData] = useState<DagData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDag = useCallback(async () => {
    try {
      const data = await api<DagData>("/api/tasks/dag");
      setDagData(data);
      setError(null);
    } catch {
      setError("Failed to load DAG");
    }
  }, []);

  useEffect(() => { loadDag(); }, [loadDag]);

  const flowNodes: Node[] = useMemo(() => {
    if (!dagData) return [];
    return dagData.nodes.map((n, i) => ({
      id: n.id,
      data: { label: `${n.id}: ${n.title.slice(0, 30)}` },
      position: { x: 50 + (i % 4) * 250, y: 50 + Math.floor(i / 4) * 120 },
      style: {
        background: STATUS_COLORS[n.status] ?? "#52525b",
        color: "#fff",
        border: "1px solid #3f3f46",
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "12px",
        minWidth: "180px",
      },
    }));
  }, [dagData]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!dagData) return [];
    return dagData.edges.map(e => ({
      id: `${e.from_task}-${e.to_task}`,
      source: e.from_task,
      target: e.to_task,
      animated: e.edge_type === "dependency",
      style: { stroke: e.edge_type === "on_failure" ? "#ef4444" : "#6b7280" },
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  }, [dagData]);

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const onConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    try {
      const result = await api<{ ok?: boolean; error?: string }>("/api/tasks/edges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: connection.source, to: connection.target }),
      });
      if (result.error) {
        setError(result.error);
        setTimeout(() => setError(null), 3000);
        return;
      }
      setEdges(eds => addEdge({ ...connection, animated: true, markerEnd: { type: MarkerType.ArrowClosed } }, eds));
    } catch {
      setError("Failed to add edge");
    }
  }, [setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    onSelectTask?.(node.id);
  }, [onSelectTask]);

  if (!dagData) return <div className="text-zinc-500 p-4">Loading DAG...</div>;

  return (
    <div className="h-full w-full relative">
      {error && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-red-900/80 text-red-200 px-3 py-1 rounded text-xs">
          {error}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        fitView
        style={{ background: "#18181b" }}
      >
        <Controls />
        <Background color="#27272a" gap={20} />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 3: Add DAG view to App.tsx**

In `web/src/App.tsx`, add a "DAG" tab/button to the view selector. Add a lazy import:

```tsx
import { lazy, Suspense } from "react";
const DagEditor = lazy(() => import("./components/DagEditor"));
```

Add a "dag" option to the view state, and render the DagEditor when selected:

```tsx
{view === "dag" && (
  <Suspense fallback={<div className="text-zinc-500 p-4">Loading DAG editor...</div>}>
    <div className="h-[500px]">
      <DagEditor onSelectTask={(id) => { /* select task */ }} />
    </div>
  </Suspense>
)}
```

Add a button to toggle DAG view in the task list header area.

- [ ] **Step 4: Build web**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/ src/
git commit -m "feat: add ReactFlow DAG editor with dependency management"
```
