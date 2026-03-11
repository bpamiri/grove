import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateSourceRef, scanMarkers } from "../../src/lib/scanner";

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
