import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  generateSourceRef,
  scanMarkers,
  detectToolchain,
  parseNpmOutdated,
  scanSignals,
} from "../../src/lib/scanner";

let tempDir: string;

function writeFile(relPath: string, content: string) {
  const fullPath = join(tempDir, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-scanner-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("generateSourceRef", () => {
  test("joins parts with colon", () => {
    expect(generateSourceRef("scan", "wheels", "src/foo.ts", "42", "TODO")).toBe(
      "scan:wheels:src/foo.ts:42:TODO",
    );
  });
});

describe("scanMarkers", () => {
  test("finds TODO comments", () => {
    writeFile("src/app.ts", "// TODO: fix routing logic\n");
    const findings = scanMarkers(tempDir, "wheels");
    expect(findings.length).toBe(1);
    expect(findings[0].type).toBe("TODO");
    expect(findings[0].file).toBe("src/app.ts");
    expect(findings[0].line).toBe(1);
    expect(findings[0].title.startsWith("TODO:")).toBe(true);
    expect(findings[0].sourceRef).toBe(
      generateSourceRef("scan", "wheels", "src/app.ts", "1", "TODO"),
    );
  });

  test("finds all marker types", () => {
    writeFile(
      "src/mixed.ts",
      [
        "// TODO: a",
        "// FIXME: b",
        "// HACK: c",
        "// XXX: d",
        "// DEPRECATED: e",
      ].join("\n"),
    );
    const findings = scanMarkers(tempDir, "test");
    expect(findings.length).toBe(5);
    const types = findings.map((f) => f.type);
    expect(types).toContain("TODO");
    expect(types).toContain("FIXME");
    expect(types).toContain("HACK");
    expect(types).toContain("XXX");
    expect(types).toContain("DEPRECATED");
  });

  test("is case-insensitive", () => {
    writeFile("src/case.ts", "// todo: lower\n// Todo: mixed\n");
    const findings = scanMarkers(tempDir, "test");
    expect(findings.length).toBe(2);
  });

  test("skips node_modules and .git directories", () => {
    writeFile("node_modules/lib.js", "// TODO: x\n");
    writeFile(".git/hooks/pre-commit", "// TODO: x\n");
    const findings = scanMarkers(tempDir, "test");
    expect(findings.length).toBe(0);
  });

  test("skips binary file extensions", () => {
    writeFile("image.png", "TODO: not code\n");
    writeFile("real.ts", "// TODO: real\n");
    const findings = scanMarkers(tempDir, "test");
    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe("real.ts");
  });

  test("handles nested directories", () => {
    writeFile("src/lib/deep/nested/file.ts", "// FIXME: nested bug\n");
    const findings = scanMarkers(tempDir, "test");
    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe("src/lib/deep/nested/file.ts");
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      writeFile(`src/file${i}.ts`, `// TODO: item ${i}\n`);
    }
    const findings = scanMarkers(tempDir, "test", 3);
    expect(findings.length).toBe(3);
  });

  test("returns empty for clean directory", () => {
    writeFile("src/clean.ts", "const x = 1;\nconsole.log(x);\n");
    const findings = scanMarkers(tempDir, "test");
    expect(findings).toEqual([]);
  });

  test("skips unreadable directories without crashing", () => {
    writeFile("src/good.ts", "// TODO: accessible\n");
    writeFile("src/secret/hidden.ts", "// TODO: hidden\n");
    chmodSync(join(tempDir, "src/secret"), 0o000);
    try {
      const findings = scanMarkers(tempDir, "test");
      expect(findings.length).toBe(1);
      expect(findings[0].file).toBe("src/good.ts");
    } finally {
      chmodSync(join(tempDir, "src/secret"), 0o755);
    }
  });
});

describe("detectToolchain", () => {
  test("identifies bun project", () => {
    writeFile("package.json", "{}");
    writeFile("bunfig.toml", "");
    const tc = detectToolchain(tempDir);
    expect(tc.runtime).toBe("bun");
  });

  test("identifies node project", () => {
    writeFile("package.json", "{}");
    const tc = detectToolchain(tempDir);
    expect(tc.runtime).toBe("node");
  });

  test("identifies python project", () => {
    writeFile("pyproject.toml", "");
    const tc = detectToolchain(tempDir);
    expect(tc.runtime).toBe("python");
  });

  test("returns null runtime for unknown project", () => {
    const tc = detectToolchain(tempDir);
    expect(tc.runtime).toBe(null);
  });
});

describe("scanSignals", () => {
  test("parseNpmOutdated extracts major version bumps", () => {
    const json = JSON.stringify({
      lodash: { current: "4.17.21", wanted: "4.17.21", latest: "5.0.0", location: "" },
      chalk: { current: "5.2.0", wanted: "5.3.0", latest: "5.3.0", location: "" },
    });
    const results = parseNpmOutdated(json);
    expect(results.length).toBe(1);
    expect(results[0].pkg).toBe("lodash");
    expect(results[0].current).toBe("4.17.21");
    expect(results[0].latest).toBe("5.0.0");
  });

  test("generates correct source refs for signals", () => {
    const ref = generateSourceRef("scan", "wheels", "signal", "outdep", "lodash");
    expect(ref).toBe("scan:wheels:signal:outdep:lodash");
  });

  test("scanSignals returns empty when no toolchain detected", () => {
    const findings = scanSignals(tempDir, "test");
    expect(findings).toEqual([]);
  });

  test("scanSignals handles command failure gracefully", () => {
    writeFile("package.json", "{}");
    const spy = spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    } as any);
    try {
      const findings = scanSignals(tempDir, "test");
      expect(findings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
