import { describe, test, expect } from "bun:test";
import { getPlatformAssetName, fetchLatestVersion } from "../../src/cli/update-check";

const originalFetch = globalThis.fetch;

describe("getPlatformAssetName", () => {
  test("returns asset name for current platform", () => {
    const name = getPlatformAssetName();
    expect(["grove-darwin-arm64", "grove-darwin-x64", "grove-linux-x64"]).toContain(name);
  });

  test("returns correct format", () => {
    const name = getPlatformAssetName();
    expect(name).toMatch(/^grove-(darwin|linux)-(arm64|x64)$/);
  });
});

describe("fetchLatestVersion", () => {
  test("parses GitHub API response and constructs URLs", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v3.1.0" }), {
        headers: { "Content-Type": "application/json" },
      });

    const result = await fetchLatestVersion();

    expect(result.version).toBe("3.1.0");
    expect(result.tarballUrl).toContain("v3.1.0");
    expect(result.tarballUrl).toEndWith(".tar.gz");
    expect(result.checksumUrl).toEndWith(".tar.gz.sha256");

    globalThis.fetch = originalFetch;
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = async () =>
      new Response("rate limited", { status: 403 });

    expect(fetchLatestVersion()).rejects.toThrow("GitHub API returned 403");

    globalThis.fetch = originalFetch;
  });
});
