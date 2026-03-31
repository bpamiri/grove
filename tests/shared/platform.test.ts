import { describe, test, expect, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { groveHome, expandTilde, realPath, tempDir, isWindows } from "../../src/shared/platform";

describe("expandTilde", () => {
  test("expands ~/path to homedir/path", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  test("expands bare ~ to homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  test("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  test("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("groveHome", () => {
  const origGroveHome = process.env.GROVE_HOME;

  afterEach(() => {
    if (origGroveHome !== undefined) {
      process.env.GROVE_HOME = origGroveHome;
    } else {
      delete process.env.GROVE_HOME;
    }
  });

  test("defaults to homedir/.grove", () => {
    delete process.env.GROVE_HOME;
    expect(groveHome()).toBe(`${homedir()}/.grove`);
  });

  test("respects GROVE_HOME env override", () => {
    process.env.GROVE_HOME = "/custom/grove";
    expect(groveHome()).toBe("/custom/grove");
  });
});

describe("realPath", () => {
  test("resolves existing directory", () => {
    const resolved = realPath(tmpdir());
    expect(typeof resolved).toBe("string");
    expect(existsSync(resolved)).toBe(true);
  });
});

describe("tempDir", () => {
  test("returns a valid directory", () => {
    const dir = tempDir();
    expect(typeof dir).toBe("string");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("isWindows", () => {
  test("is a boolean", () => {
    expect(typeof isWindows).toBe("boolean");
  });
});
