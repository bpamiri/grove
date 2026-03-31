import { describe, test, expect } from "bun:test";
import { filterExternalPRs, parsePrReviewConfig } from "../../src/pr/poller";

describe("filterExternalPRs", () => {
  const prs = [
    { number: 1, headRefName: "grove/W-001-fix-bug" },
    { number: 2, headRefName: "feature/add-pagination" },
    { number: 3, headRefName: "grove/W-002-refactor" },
    { number: 4, headRefName: "fix/typo-in-readme" },
    { number: 5, headRefName: "peter/grove/W-003-test" },
  ];

  test("excludes PRs with grove/ prefix", () => {
    const result = filterExternalPRs(prs, "grove/");
    expect(result.map(p => p.number)).toEqual([2, 4, 5]);
  });

  test("handles empty PR list", () => {
    expect(filterExternalPRs([], "grove/")).toEqual([]);
  });

  test("handles custom prefix", () => {
    const result = filterExternalPRs(prs, "peter/");
    expect(result.map(p => p.number)).toEqual([1, 2, 3, 4]);
  });
});

describe("parsePrReviewConfig", () => {
  test("returns null for null config", () => {
    expect(parsePrReviewConfig(null)).toBeNull();
  });

  test("returns null when pr_review not enabled", () => {
    expect(parsePrReviewConfig(JSON.stringify({ pr_review: { enabled: false } }))).toBeNull();
  });

  test("returns null when no pr_review key", () => {
    expect(parsePrReviewConfig(JSON.stringify({ quality_gates: {} }))).toBeNull();
  });

  test("parses enabled config with defaults", () => {
    const config = parsePrReviewConfig(JSON.stringify({ pr_review: { enabled: true } }));
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.poll_interval).toBe(300);
    expect(config!.auto_dispatch).toBe(false);
  });

  test("parses custom values", () => {
    const config = parsePrReviewConfig(JSON.stringify({
      pr_review: { enabled: true, poll_interval: 60, auto_dispatch: true, prompt: "Custom review" },
    }));
    expect(config!.poll_interval).toBe(60);
    expect(config!.auto_dispatch).toBe(true);
    expect(config!.prompt).toBe("Custom review");
  });
});
