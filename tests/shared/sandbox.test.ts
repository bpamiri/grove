import { describe, test, expect } from "bun:test";
import { buildOverlay } from "../../src/shared/sandbox";
import type { OverlayContext } from "../../src/shared/sandbox";

// ---------------------------------------------------------------------------
// buildOverlay — CLAUDE.md content for worker sessions
// ---------------------------------------------------------------------------

const baseCtx: OverlayContext = {
  taskId: "T-001",
  title: "Add feature X",
  treePath: "/tmp/fake-tree",
};

describe("buildOverlay", () => {
  test("includes task header and title", () => {
    const overlay = buildOverlay(baseCtx);
    expect(overlay).toContain("# Task: T-001");
    expect(overlay).toContain("## Add feature X");
  });

  test("includes strategy section", () => {
    const overlay = buildOverlay(baseCtx);
    expect(overlay).toContain("### Strategy");
  });

  test("includes description when provided", () => {
    const overlay = buildOverlay({ ...baseCtx, description: "Build the widget" });
    expect(overlay).toContain("### Description");
    expect(overlay).toContain("Build the widget");
  });

  test("omits description when null", () => {
    const overlay = buildOverlay({ ...baseCtx, description: null });
    expect(overlay).not.toContain("### Description");
  });

  // ---------------------------------------------------------------------------
  // worker_instructions
  // ---------------------------------------------------------------------------

  test("includes worker instructions when provided", () => {
    const overlay = buildOverlay({
      ...baseCtx,
      workerInstructions: "Run tests with: box testbox run\nAlways restart after config changes.",
    });
    expect(overlay).toContain("### Worker Instructions");
    expect(overlay).toContain("Run tests with: box testbox run");
    expect(overlay).toContain("Always restart after config changes.");
  });

  test("omits worker instructions when null", () => {
    const overlay = buildOverlay({ ...baseCtx, workerInstructions: null });
    expect(overlay).not.toContain("### Worker Instructions");
  });

  test("omits worker instructions when undefined", () => {
    const overlay = buildOverlay(baseCtx);
    expect(overlay).not.toContain("### Worker Instructions");
  });

  test("omits worker instructions when empty string", () => {
    const overlay = buildOverlay({ ...baseCtx, workerInstructions: "" });
    expect(overlay).not.toContain("### Worker Instructions");
  });

  test("worker instructions appear after workflow and before strategy", () => {
    const overlay = buildOverlay({
      ...baseCtx,
      pathName: "development",
      workerInstructions: "Use uv run pytest",
    });
    const workflowIdx = overlay.indexOf("### Workflow");
    const instructionsIdx = overlay.indexOf("### Worker Instructions");
    const strategyIdx = overlay.indexOf("### Strategy");

    expect(workflowIdx).toBeGreaterThan(-1);
    expect(instructionsIdx).toBeGreaterThan(workflowIdx);
    expect(strategyIdx).toBeGreaterThan(instructionsIdx);
  });

  test("worker instructions appear before strategy when no workflow", () => {
    const overlay = buildOverlay({
      ...baseCtx,
      workerInstructions: "Use uv run pytest",
    });
    const instructionsIdx = overlay.indexOf("### Worker Instructions");
    const strategyIdx = overlay.indexOf("### Strategy");

    expect(instructionsIdx).toBeGreaterThan(-1);
    expect(strategyIdx).toBeGreaterThan(instructionsIdx);
  });

  test("preserves multiline worker instructions", () => {
    const instructions = `This is a CFWheels CFML application running on CommandBox.
Run tests with: box testbox run
Always restart the server after modifying config: box server restart`;

    const overlay = buildOverlay({
      ...baseCtx,
      workerInstructions: instructions,
    });
    expect(overlay).toContain(instructions);
  });
});
