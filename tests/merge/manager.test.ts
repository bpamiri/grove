import { describe, test, expect } from "bun:test";
import { treeDefaultBranch } from "../../src/merge/manager";
import type { Tree } from "../../src/shared/types";

function makeTree(config: string): Tree {
  return {
    id: "test",
    name: "test",
    path: "/tmp/test",
    github: "org/repo",
    branch_prefix: "grove/",
    config,
    created_at: new Date().toISOString(),
  };
}

describe("treeDefaultBranch", () => {
  test("returns configured default_branch", () => {
    expect(treeDefaultBranch(makeTree(JSON.stringify({ default_branch: "develop" })))).toBe("develop");
  });

  test("returns 'main' when not configured", () => {
    expect(treeDefaultBranch(makeTree("{}"))).toBe("main");
  });

  test("returns 'main' for empty config", () => {
    expect(treeDefaultBranch(makeTree(""))).toBe("main");
  });

  test("returns 'main' for invalid JSON", () => {
    expect(treeDefaultBranch(makeTree("not-json"))).toBe("main");
  });

  test("returns 'main' when default_branch is empty string", () => {
    expect(treeDefaultBranch(makeTree(JSON.stringify({ default_branch: "" })))).toBe("main");
  });

  test("works with quality_gates alongside default_branch", () => {
    const config = JSON.stringify({
      quality_gates: { tests: true },
      default_branch: "master",
    });
    expect(treeDefaultBranch(makeTree(config))).toBe("master");
  });
});
