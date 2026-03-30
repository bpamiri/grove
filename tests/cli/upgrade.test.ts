import { describe, test, expect } from "bun:test";
import { getPlatformAssetName, fetchLatestVersion } from "../../src/cli/update-check";

const originalFetch = globalThis.fetch;

describe("upgrade prerequisites", () => {
  test("getPlatformAssetName returns valid asset for this machine", () => {
    const name = getPlatformAssetName();
    expect(name).toMatch(/^grove-(darwin|linux)-(arm64|x64)$/);
  });

  test("fetchLatestVersion constructs correct download URLs", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v4.0.0" }));

    const release = await fetchLatestVersion();
    const asset = getPlatformAssetName();

    expect(release.tarballUrl).toBe(
      `https://github.com/bpamiri/grove/releases/download/v4.0.0/${asset}.tar.gz`
    );
    expect(release.checksumUrl).toBe(
      `https://github.com/bpamiri/grove/releases/download/v4.0.0/${asset}.tar.gz.sha256`
    );

    globalThis.fetch = originalFetch;
  });
});

describe("verifyChecksum", () => {
  test("matches correct checksum", async () => {
    const { verifyChecksum } = await import("../../src/cli/commands/upgrade");
    const content = new Uint8Array([1, 2, 3, 4]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const expected = hasher.digest("hex");

    expect(verifyChecksum(content, `${expected}  grove-test.tar.gz`)).toBe(true);
  });

  test("rejects wrong checksum", async () => {
    const { verifyChecksum } = await import("../../src/cli/commands/upgrade");
    const content = new Uint8Array([1, 2, 3, 4]);
    expect(verifyChecksum(content, "0000000000000000000000000000000000000000000000000000000000000000  grove-test.tar.gz")).toBe(false);
  });
});
