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
    expect(prompt).toContain("truncated");
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
