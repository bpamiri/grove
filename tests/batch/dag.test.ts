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
