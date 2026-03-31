// Grove v3 — DAG algorithms for task dependency management

export interface DagEdge {
  from: string;  // dependency (must complete first)
  to: string;    // dependent (waits for from)
}

/** Detect cycle using DFS 3-color algorithm. Returns cycle path or null. */
export function detectCycle(nodeIds: string[], edges: DagEdge[]): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
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
      const cycle = dfs(id, color, adj);
      if (cycle) return cycle;
    }
  }
  return null;
}

function dfs(
  node: string,
  color: Map<string, number>,
  adj: Map<string, string[]>,
): string[] | null {
  const GRAY = 1, BLACK = 2;
  color.set(node, GRAY);

  for (const neighbor of adj.get(node) ?? []) {
    if (color.get(neighbor) === GRAY) {
      // Found cycle — reconstruct path
      return [neighbor, node];
    }
    if (color.get(neighbor) === 0 /* WHITE */) {
      const result = dfs(neighbor, color, adj);
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
