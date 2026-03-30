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

import { checkForUpdate } from "../../src/cli/update-check";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("checkForUpdate", () => {
  const testHome = join(tmpdir(), "grove-test-update-" + Date.now());
  const cacheFile = join(testHome, "update-check.json");
  const origEnv = process.env.GROVE_HOME;

  function setup() {
    mkdirSync(testHome, { recursive: true });
    process.env.GROVE_HOME = testHome;
  }

  function teardown() {
    if (existsSync(testHome)) rmSync(testHome, { recursive: true });
    process.env.GROVE_HOME = origEnv;
    globalThis.fetch = originalFetch;
  }

  test("writes cache file after checking", async () => {
    setup();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v3.0.0-alpha.0" }), {
        headers: { "Content-Type": "application/json" },
      });

    await checkForUpdate();

    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.latest_version).toBe("3.0.0-alpha.0");
    expect(cache.checked_at).toBeTruthy();
    teardown();
  });

  test("uses cache when recent", async () => {
    setup();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ tag_name: "v3.0.0-alpha.0" }));
    };

    // Write fresh cache
    writeFileSync(cacheFile, JSON.stringify({
      checked_at: new Date().toISOString(),
      latest_version: "3.0.0-alpha.0",
    }));

    await checkForUpdate();

    expect(fetchCalled).toBe(false);
    teardown();
  });

  test("skips when GROVE_NO_UPDATE_CHECK=1", async () => {
    setup();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ tag_name: "v99.0.0" }));
    };

    process.env.GROVE_NO_UPDATE_CHECK = "1";
    await checkForUpdate();
    delete process.env.GROVE_NO_UPDATE_CHECK;

    expect(fetchCalled).toBe(false);
    teardown();
  });

  test("silently swallows errors", async () => {
    setup();
    globalThis.fetch = async () => { throw new Error("network down"); };

    // Should not throw
    await checkForUpdate();
    teardown();
  });
});
