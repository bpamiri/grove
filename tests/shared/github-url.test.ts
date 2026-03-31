import { describe, test, expect } from "bun:test";
import { parseGithubRemote, detectGithubRemote } from "../../src/shared/github";

describe("parseGithubRemote", () => {
  test("parses HTTPS URL with .git suffix", () => {
    expect(parseGithubRemote("https://github.com/paiindustries/titan.git")).toBe("paiindustries/titan");
  });

  test("parses HTTPS URL without .git suffix", () => {
    expect(parseGithubRemote("https://github.com/org/repo")).toBe("org/repo");
  });

  test("parses SSH URL", () => {
    expect(parseGithubRemote("git@github.com:bpamiri/grove.git")).toBe("bpamiri/grove");
  });

  test("parses SSH protocol URL", () => {
    expect(parseGithubRemote("ssh://git@github.com/org/repo.git")).toBe("org/repo");
  });

  test("handles repo names with dots", () => {
    expect(parseGithubRemote("https://github.com/wheels-dev/wheels.dev.git")).toBe("wheels-dev/wheels.dev");
  });

  test("handles repo names with multiple dots", () => {
    expect(parseGithubRemote("https://github.com/org/my.dotted.repo.git")).toBe("org/my.dotted.repo");
  });

  test("returns null for non-GitHub URLs", () => {
    expect(parseGithubRemote("https://gitlab.com/org/repo.git")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseGithubRemote("")).toBeNull();
  });
});

describe("detectGithubRemote", () => {
  test("detects GitHub remote from a real git repo", () => {
    // Use the grove repo itself as a test subject
    const result = detectGithubRemote(import.meta.dir);
    // This test runs inside the grove repo, so it should detect bpamiri/grove
    expect(result).toBe("bpamiri/grove");
  });

  test("returns null for non-git directory", () => {
    const result = detectGithubRemote("/tmp");
    expect(result).toBeNull();
  });
});
