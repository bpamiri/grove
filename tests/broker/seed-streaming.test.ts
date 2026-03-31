import { describe, test, expect } from "bun:test";
import { detectSeedStage } from "../../src/broker/seed-session";

describe("detectSeedStage", () => {
  test("detects exploring stage", () => {
    expect(detectSeedStage("Let me explore the codebase to understand")).toBe("exploring");
    expect(detectSeedStage("I'll read the relevant files")).toBe("exploring");
  });

  test("detects clarifying stage", () => {
    expect(detectSeedStage("I have a question about the requirements")).toBe("clarifying");
    expect(detectSeedStage("Which option would you prefer?\nA) JWT\nB) Sessions")).toBe("clarifying");
  });

  test("detects proposing stage", () => {
    expect(detectSeedStage("Here are 2-3 approaches we could take")).toBe("proposing");
    expect(detectSeedStage("I'd recommend Option A because")).toBe("proposing");
  });

  test("detects designing stage", () => {
    expect(detectSeedStage("Here's my recommended design for the auth module")).toBe("designing");
    expect(detectSeedStage("## Architecture\nThe system will use")).toBe("designing");
  });

  test("returns null for ambiguous text", () => {
    expect(detectSeedStage("OK")).toBeNull();
    expect(detectSeedStage("Got it, I understand")).toBeNull();
  });
});
