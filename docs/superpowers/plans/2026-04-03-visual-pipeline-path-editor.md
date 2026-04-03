# Visual Pipeline Path Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual step editor to the Grove GUI so users can create, edit, and delete pipeline paths without manually editing grove.yaml.

**Architecture:** Backend path CRUD functions in `config.ts` with REST endpoints in `server.ts`. Frontend `PathEditor.tsx` component rendered inside `Settings.tsx` with step reordering via native HTML drag, per-step config fields, live Pipeline preview, and skill multi-select populated from `/api/skills`.

**Tech Stack:** Bun, TypeScript, React 19, Tailwind CSS v4, existing `api()` client

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/broker/config.ts` | Add `configSetPath()`, `configDeletePath()` for YAML persistence |
| Modify | `src/broker/server.ts:549` | Add `POST /api/paths`, `PUT /api/paths/:name`, `DELETE /api/paths/:name` |
| Modify | `src/engine/normalize.ts` | Add `validatePathConfig()` for input validation before save |
| Create | `web/src/components/PathEditor.tsx` | Full path editor: step list, drag reorder, per-step config, preview |
| Modify | `web/src/components/Settings.tsx` | Add Paths section with list + edit/create/delete buttons |
| Modify | `web/src/components/Pipeline.tsx` | Add `PipelinePreview` export for static (non-task) step preview |
| Create | `tests/broker/server-paths.test.ts` | Tests for path CRUD config functions + validation |

---

### Task 1: Path Config CRUD in config.ts

**Files:**
- Modify: `src/broker/config.ts:124-134`
- Test: `tests/broker/server-paths.test.ts` (create)

- [ ] **Step 1: Write failing tests for configSetPath and configDeletePath**

Create `tests/broker/server-paths.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

const TEST_DIR = join(import.meta.dir, "test-config-paths");
process.env.GROVE_HOME = TEST_DIR;

const { reloadConfig, configPaths, configSetPath, configDeletePath } = await import("../../src/broker/config");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "grove.yaml"), stringifyYaml({
    workspace: { name: "Test" },
    paths: {
      development: {
        description: "Standard dev workflow",
        steps: [
          { id: "implement", type: "worker", prompt: "Do the work" },
          { id: "review", type: "worker", sandbox: "read-only" },
        ],
      },
    },
  }));
  reloadConfig();
});

afterEach(() => {
  const p = join(TEST_DIR, "grove.yaml");
  if (existsSync(p)) unlinkSync(p);
  reloadConfig();
});

describe("configSetPath", () => {
  test("creates a new path", () => {
    configSetPath("custom", {
      description: "Custom workflow",
      steps: [{ id: "build", type: "worker", prompt: "Build it" }],
    });
    const paths = configPaths();
    expect(paths.custom).toBeDefined();
    expect(paths.custom.description).toBe("Custom workflow");
    expect(paths.custom.steps).toHaveLength(1);
  });

  test("overwrites an existing path", () => {
    configSetPath("development", {
      description: "Updated dev",
      steps: [{ id: "code", type: "worker", prompt: "Code it" }],
    });
    const paths = configPaths();
    expect(paths.development.description).toBe("Updated dev");
    expect(paths.development.steps).toHaveLength(1);
  });

  test("persists to YAML on disk", () => {
    configSetPath("persisted", {
      description: "Should survive reload",
      steps: [{ id: "work", type: "worker" }],
    });
    reloadConfig();
    const paths = configPaths();
    expect(paths.persisted).toBeDefined();
    expect(paths.persisted.description).toBe("Should survive reload");
  });
});

describe("configDeletePath", () => {
  test("removes an existing path", () => {
    configDeletePath("development");
    const paths = configPaths();
    expect(paths.development).toBeUndefined();
  });

  test("no-ops for nonexistent path", () => {
    configDeletePath("nonexistent");
    const paths = configPaths();
    expect(paths.development).toBeDefined();
  });

  test("persists deletion to disk", () => {
    configDeletePath("development");
    reloadConfig();
    // development comes back from DEFAULT_PATHS merge, but the YAML file should not have it
    const raw = readFileSync(join(TEST_DIR, "grove.yaml"), "utf-8");
    const parsed = parseYaml(raw) as any;
    expect(parsed.paths?.development).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: FAIL — `configSetPath` and `configDeletePath` are not exported.

- [ ] **Step 3: Implement configSetPath and configDeletePath**

Add to `src/broker/config.ts` after the existing `configDeleteTree` function (line 100):

```typescript
export function configSetPath(name: string, pathConfig: PathConfig): void {
  const { GROVE_CONFIG } = getEnv();
  const config = loadConfig();
  if (!config.paths) config.paths = {};
  config.paths[name] = pathConfig;
  writeFileSync(GROVE_CONFIG, stringifyYaml(config));
  _config = config;
}

export function configDeletePath(name: string): void {
  const { GROVE_CONFIG } = getEnv();
  const config = loadConfig();
  if (!config.paths || !(name in config.paths)) return;
  delete config.paths[name];
  writeFileSync(GROVE_CONFIG, stringifyYaml(config));
  _config = config;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/broker/config.ts tests/broker/server-paths.test.ts
git commit -m "feat: (W-062) add configSetPath and configDeletePath for path CRUD"
```

---

### Task 2: Path Validation in normalize.ts

**Files:**
- Modify: `src/engine/normalize.ts`
- Modify: `tests/broker/server-paths.test.ts`

- [ ] **Step 1: Write failing tests for validatePathConfig**

Append to `tests/broker/server-paths.test.ts`:

```typescript
import { validatePathConfig } from "../../src/engine/normalize";

describe("validatePathConfig", () => {
  test("accepts valid path config", () => {
    const errors = validatePathConfig({
      description: "Valid path",
      steps: [
        { id: "work", type: "worker", prompt: "Do it" },
        { id: "check", type: "verdict" },
      ],
    });
    expect(errors).toEqual([]);
  });

  test("rejects missing description", () => {
    const errors = validatePathConfig({ description: "", steps: [{ id: "a", type: "worker" }] });
    expect(errors).toContain("description is required");
  });

  test("rejects empty steps array", () => {
    const errors = validatePathConfig({ description: "No steps", steps: [] });
    expect(errors).toContain("at least one step is required");
  });

  test("rejects step without id", () => {
    const errors = validatePathConfig({ description: "Bad step", steps: [{ id: "", type: "worker" }] });
    expect(errors.some(e => e.includes("id"))).toBe(true);
  });

  test("rejects invalid step type", () => {
    const errors = validatePathConfig({ description: "Bad type", steps: [{ id: "x", type: "bogus" }] });
    expect(errors.some(e => e.includes("type"))).toBe(true);
  });

  test("rejects duplicate step ids", () => {
    const errors = validatePathConfig({
      description: "Dupes",
      steps: [
        { id: "work", type: "worker" },
        { id: "work", type: "worker" },
      ],
    });
    expect(errors.some(e => e.includes("duplicate"))).toBe(true);
  });

  test("rejects on_success referencing nonexistent step", () => {
    const errors = validatePathConfig({
      description: "Bad ref",
      steps: [{ id: "a", type: "worker", on_success: "nonexistent" }],
    });
    expect(errors.some(e => e.includes("on_success"))).toBe(true);
  });

  test("allows $done and $fail as on_success/on_failure targets", () => {
    const errors = validatePathConfig({
      description: "Terminals",
      steps: [{ id: "a", type: "worker", on_success: "$done", on_failure: "$fail" }],
    });
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: FAIL — `validatePathConfig` not exported from normalize.ts.

- [ ] **Step 3: Implement validatePathConfig**

Add to `src/engine/normalize.ts` after the existing imports:

```typescript
export function validatePathConfig(config: { description: string; steps: Array<Record<string, any>> }): string[] {
  const errors: string[] = [];

  if (!config.description?.trim()) errors.push("description is required");
  if (!config.steps || config.steps.length === 0) {
    errors.push("at least one step is required");
    return errors;
  }

  const ids = new Set<string>();
  const TERMINAL = new Set(["$done", "$fail"]);

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    const prefix = `step[${i}]`;

    if (!step.id?.trim()) {
      errors.push(`${prefix}: id is required`);
      continue;
    }

    if (ids.has(step.id)) {
      errors.push(`${prefix}: duplicate id "${step.id}"`);
    }
    ids.add(step.id);

    if (step.type && !VALID_TYPES.has(step.type)) {
      errors.push(`${prefix}: invalid type "${step.type}" (must be worker or verdict)`);
    }
  }

  // Second pass: validate references after collecting all ids
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    if (step.on_success && !TERMINAL.has(step.on_success) && !ids.has(step.on_success)) {
      errors.push(`step[${i}]: on_success references nonexistent step "${step.on_success}"`);
    }
    if (step.on_failure && !TERMINAL.has(step.on_failure) && !ids.has(step.on_failure)) {
      errors.push(`step[${i}]: on_failure references nonexistent step "${step.on_failure}"`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: All 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/normalize.ts tests/broker/server-paths.test.ts
git commit -m "feat: (W-062) add validatePathConfig for path input validation"
```

---

### Task 3: REST Endpoints for Path CRUD

**Files:**
- Modify: `src/broker/server.ts:549-553`
- Modify: `tests/broker/server-paths.test.ts`

- [ ] **Step 1: Write failing tests for the API endpoints**

Append to `tests/broker/server-paths.test.ts`:

```typescript
describe("Path API endpoint logic", () => {
  test("POST /api/paths — validates and saves new path", () => {
    const body = {
      description: "API-created path",
      steps: [{ id: "work", type: "worker", prompt: "Do the thing" }],
    };
    // Simulate: validate then save
    const errors = validatePathConfig(body);
    expect(errors).toEqual([]);
    configSetPath("api-path", body);
    const paths = configPaths();
    expect(paths["api-path"]).toBeDefined();
    expect(paths["api-path"].description).toBe("API-created path");
  });

  test("POST /api/paths — rejects invalid config", () => {
    const body = { description: "", steps: [] };
    const errors = validatePathConfig(body);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("PUT /api/paths/:name — updates existing path", () => {
    const updated = {
      description: "Updated dev",
      steps: [{ id: "code", type: "worker", prompt: "Write code" }],
    };
    configSetPath("development", updated);
    reloadConfig();
    const paths = configPaths();
    expect(paths.development.description).toBe("Updated dev");
  });

  test("DELETE /api/paths/:name — removes path from config", () => {
    configSetPath("temp-path", { description: "Temp", steps: [{ id: "a", type: "worker" }] });
    configDeletePath("temp-path");
    reloadConfig();
    const raw = readFileSync(join(TEST_DIR, "grove.yaml"), "utf-8");
    const parsed = parseYaml(raw) as any;
    expect(parsed.paths?.["temp-path"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (these test the config layer, which is already implemented)

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: All 18 tests PASS.

- [ ] **Step 3: Add REST endpoints to server.ts**

Insert after the existing `GET /api/paths` block (line 553) in `src/broker/server.ts`:

```typescript
    // POST /api/paths — create a new path
    if (path === "/api/paths" && req.method === "POST") {
      const body = await req.json() as { name?: string; description?: string; steps?: any[] };
      if (!body.name?.trim()) return json({ error: "name is required" }, 400);
      const { configPaths: getPaths, configSetPath } = await import("./config");
      const existing = getPaths();
      if (body.name in existing) return json({ error: `Path "${body.name}" already exists` }, 409);
      const { validatePathConfig } = await import("../engine/normalize");
      const errors = validatePathConfig({ description: body.description ?? "", steps: body.steps ?? [] });
      if (errors.length > 0) return json({ error: "Validation failed", details: errors }, 400);
      const pathConfig = { description: body.description!, steps: body.steps! };
      configSetPath(body.name, pathConfig);
      const { configNormalizedPathsForApi } = await import("./config");
      return json(configNormalizedPathsForApi()[body.name], 201);
    }

    // PUT /api/paths/:name — update an existing path
    const pathUpdateMatch = path.match(/^\/api\/paths\/([^/]+)$/);
    if (pathUpdateMatch && req.method === "PUT") {
      const name = decodeURIComponent(pathUpdateMatch[1]);
      const { configPaths: getPaths, configSetPath } = await import("./config");
      const existing = getPaths();
      if (!(name in existing)) return json({ error: "Path not found" }, 404);
      const body = await req.json() as { description?: string; steps?: any[] };
      const { validatePathConfig } = await import("../engine/normalize");
      const errors = validatePathConfig({ description: body.description ?? "", steps: body.steps ?? [] });
      if (errors.length > 0) return json({ error: "Validation failed", details: errors }, 400);
      configSetPath(name, { description: body.description!, steps: body.steps! });
      const { configNormalizedPathsForApi } = await import("./config");
      return json(configNormalizedPathsForApi()[name]);
    }

    // DELETE /api/paths/:name — remove a path (prevent deleting built-in paths)
    if (pathUpdateMatch && req.method === "DELETE") {
      const name = decodeURIComponent(pathUpdateMatch[1]);
      const { DEFAULT_PATHS } = await import("../shared/types");
      if (name in DEFAULT_PATHS) return json({ error: `Cannot delete built-in path "${name}"` }, 403);
      const { configPaths: getPaths, configDeletePath } = await import("./config");
      const existing = getPaths();
      if (!(name in existing)) return json({ error: "Path not found" }, 404);
      configDeletePath(name);
      return json({ ok: true });
    }
```

- [ ] **Step 4: Run all path tests to verify**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test tests/broker/server-paths.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: (W-062) add POST/PUT/DELETE /api/paths REST endpoints"
```

---

### Task 4: PipelinePreview Component

**Files:**
- Modify: `web/src/components/Pipeline.tsx`

- [ ] **Step 1: Add PipelinePreview export to Pipeline.tsx**

Add after the existing `Pipeline` component at end of file:

```typescript
/** Static preview of path steps — no task state, all steps shown as "pending" */
export function PipelinePreview({ steps }: { steps: Array<{ id: string; label?: string; type?: string }> }) {
  if (steps.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => (
        <div key={`${step.id}-${i}`} className="flex items-center gap-1">
          {i > 0 && <div className="w-4 h-0.5 bg-zinc-700" />}
          <div className={`px-2 py-0.5 rounded text-xs border ${
            step.type === "verdict"
              ? "bg-purple-500/12 border-purple-500/30 text-purple-400"
              : "bg-zinc-800/50 border-zinc-700/50 text-zinc-400"
          }`}>
            {step.type === "verdict" ? "◆ " : "● "}
            {step.label || step.id.charAt(0).toUpperCase() + step.id.slice(1)}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `cd /Users/peter/GitHub/bpamiri/grove && cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Pipeline.tsx
git commit -m "feat: (W-062) add PipelinePreview component for static step display"
```

---

### Task 5: PathEditor Component

**Files:**
- Create: `web/src/components/PathEditor.tsx`

This is the main editor component. It includes:
- Step list with drag-to-reorder
- Per-step configuration fields (id, type, label, skills, prompt, sandbox, result_file, result_key, on_success, on_failure, max_retries)
- Skill multi-select with "suggested" badges
- Live PipelinePreview
- Save/cancel actions

- [ ] **Step 1: Create PathEditor.tsx**

Create `web/src/components/PathEditor.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import { PipelinePreview } from "./Pipeline";

interface StepDraft {
  id: string;
  type: "worker" | "verdict";
  label: string;
  prompt: string;
  skills: string[];
  sandbox: "read-write" | "read-only";
  result_file: string;
  result_key: string;
  on_success: string;
  on_failure: string;
  max_retries: number;
}

interface SkillManifest {
  name: string;
  description: string;
  suggested_steps?: string[];
}

interface Props {
  name: string | null; // null = new path
  initial?: { description: string; steps: StepDraft[] };
  onSave: () => void;
  onCancel: () => void;
}

function emptyStep(): StepDraft {
  return {
    id: "", type: "worker", label: "", prompt: "", skills: [],
    sandbox: "read-write", result_file: "", result_key: "",
    on_success: "", on_failure: "", max_retries: 0,
  };
}

export default function PathEditor({ name, initial, onSave, onCancel }: Props) {
  const [pathName, setPathName] = useState(name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(initial?.steps ?? [emptyStep()]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(0);
  const dragIdx = useRef<number | null>(null);

  useEffect(() => {
    api<SkillManifest[]>("/api/skills").then(setSkills).catch(() => {});
  }, []);

  const updateStep = (idx: number, patch: Partial<StepDraft>) => {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  };

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx));
  };

  const addStep = () => {
    setSteps(prev => [...prev, emptyStep()]);
    setExpandedStep(steps.length);
  };

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    setSteps(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx.current!, 1);
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name ? undefined : pathName.trim(),
      description,
      steps: steps.map(s => {
        const step: Record<string, any> = { id: s.id, type: s.type };
        if (s.label.trim()) step.label = s.label;
        if (s.prompt.trim()) step.prompt = s.prompt;
        if (s.skills.length > 0) step.skills = s.skills;
        if (s.sandbox !== "read-write") step.sandbox = s.sandbox;
        if (s.result_file.trim()) step.result_file = s.result_file;
        if (s.result_key.trim()) step.result_key = s.result_key;
        if (s.on_success.trim()) step.on_success = s.on_success;
        if (s.on_failure.trim()) step.on_failure = s.on_failure;
        if (s.max_retries > 0) step.max_retries = s.max_retries;
        return step;
      }),
    };
    try {
      if (name) {
        await api(`/api/paths/${encodeURIComponent(name)}`, {
          method: "PUT", body: JSON.stringify(body),
        });
      } else {
        await api("/api/paths", { method: "POST", body: JSON.stringify(body) });
      }
      onSave();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Build step id options for on_success/on_failure dropdowns
  const stepIds = steps.map(s => s.id).filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{name ? `Edit: ${name}` : "New Path"}</h3>
        <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-400">Cancel</button>
      </div>

      {/* Path name (only for new paths) */}
      {!name && (
        <input
          type="text"
          value={pathName}
          onChange={e => setPathName(e.target.value)}
          placeholder="Path name (e.g. my-workflow)"
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
        />
      )}

      {/* Description */}
      <input
        type="text"
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Path description"
        className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
      />

      {/* Live preview */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
        <div className="text-[10px] text-zinc-600 uppercase mb-2">Preview</div>
        <PipelinePreview steps={steps.filter(s => s.id.trim())} />
      </div>

      {/* Step list */}
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={i}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={e => handleDragOver(e, i)}
            className="bg-zinc-900/50 border border-zinc-800 rounded-lg"
          >
            {/* Step header — always visible */}
            <div
              className="flex items-center gap-2 px-3 py-2 cursor-pointer"
              onClick={() => setExpandedStep(expandedStep === i ? null : i)}
            >
              <span className="text-zinc-600 cursor-grab" title="Drag to reorder">⠿</span>
              <span className="text-xs text-zinc-500 w-5">{i + 1}</span>
              <span className="text-sm flex-1">{step.id || "(unnamed)"}</span>
              <span className="text-[10px] text-zinc-600 uppercase">{step.type}</span>
              {steps.length > 1 && (
                <button
                  onClick={e => { e.stopPropagation(); removeStep(i); }}
                  className="text-xs text-red-400/60 hover:text-red-400 ml-2"
                >✕</button>
              )}
            </div>

            {/* Step fields — expanded */}
            {expandedStep === i && (
              <div className="px-3 pb-3 pt-1 border-t border-zinc-800 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">ID</label>
                    <input
                      type="text" value={step.id}
                      onChange={e => updateStep(i, { id: e.target.value })}
                      placeholder="step-id"
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Type</label>
                    <select
                      value={step.type}
                      onChange={e => updateStep(i, { type: e.target.value as StepDraft["type"] })}
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    >
                      <option value="worker">worker</option>
                      <option value="verdict">verdict</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Label</label>
                  <input
                    type="text" value={step.label}
                    onChange={e => updateStep(i, { label: e.target.value })}
                    placeholder={step.id ? step.id.charAt(0).toUpperCase() + step.id.slice(1) : "Display name"}
                    className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>

                {/* Skills multi-select */}
                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Skills</label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {skills.map(skill => {
                      const selected = step.skills.includes(skill.name);
                      const suggested = skill.suggested_steps?.includes(step.id);
                      return (
                        <button
                          key={skill.name} type="button"
                          onClick={() => updateStep(i, {
                            skills: selected
                              ? step.skills.filter(s => s !== skill.name)
                              : [...step.skills, skill.name],
                          })}
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${
                            selected
                              ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                              : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600"
                          }`}
                        >
                          {skill.name}{suggested && !selected ? " ★" : ""}
                        </button>
                      );
                    })}
                    {skills.length === 0 && (
                      <span className="text-[10px] text-zinc-600">No skills installed</span>
                    )}
                  </div>
                </div>

                {/* Prompt */}
                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Prompt</label>
                  <textarea
                    value={step.prompt}
                    onChange={e => updateStep(i, { prompt: e.target.value })}
                    placeholder="Worker instructions..."
                    rows={2}
                    className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50 resize-y"
                  />
                </div>

                {/* Sandbox toggle */}
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-zinc-600 uppercase">Sandbox</label>
                  <button
                    type="button"
                    onClick={() => updateStep(i, { sandbox: step.sandbox === "read-write" ? "read-only" : "read-write" })}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      step.sandbox === "read-only"
                        ? "bg-amber-500/15 border-amber-500/30 text-amber-400"
                        : "bg-zinc-800 border-zinc-700 text-zinc-500"
                    }`}
                  >
                    {step.sandbox}
                  </button>
                </div>

                {/* Result file + key */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Result File</label>
                    <input
                      type="text" value={step.result_file}
                      onChange={e => updateStep(i, { result_file: e.target.value })}
                      placeholder=".grove/result.json"
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Result Key</label>
                    <input
                      type="text" value={step.result_key}
                      onChange={e => updateStep(i, { result_key: e.target.value })}
                      placeholder="approved"
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    />
                  </div>
                </div>

                {/* Transitions */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">On Success</label>
                    <select
                      value={step.on_success}
                      onChange={e => updateStep(i, { on_success: e.target.value })}
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    >
                      <option value="">(auto — next step)</option>
                      <option value="$done">$done</option>
                      {stepIds.filter(id => id !== step.id).map(id => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">On Failure</label>
                    <select
                      value={step.on_failure}
                      onChange={e => updateStep(i, { on_failure: e.target.value })}
                      className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                    >
                      <option value="">(auto — $fail)</option>
                      <option value="$fail">$fail</option>
                      {stepIds.filter(id => id !== step.id).map(id => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Max retries */}
                <div className="w-32">
                  <label className="text-[10px] text-zinc-600 uppercase">Max Retries</label>
                  <input
                    type="number" min={0} max={10} value={step.max_retries}
                    onChange={e => updateStep(i, { max_retries: parseInt(e.target.value) || 0 })}
                    className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add step button */}
      <button
        type="button" onClick={addStep}
        className="w-full border border-dashed border-zinc-700 rounded-lg py-2 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-400"
      >
        + Add Step
      </button>

      {/* Error display */}
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving || (!name && !pathName.trim()) || steps.length === 0}
        className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50"
      >
        {saving ? "Saving..." : name ? "Save Changes" : "Create Path"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `cd /Users/peter/GitHub/bpamiri/grove && cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/PathEditor.tsx
git commit -m "feat: (W-062) add PathEditor component with step editor and live preview"
```

---

### Task 6: Integrate Paths Section into Settings

**Files:**
- Modify: `web/src/components/Settings.tsx`
- Modify: `web/src/App.tsx` (pass `paths` and `onRefresh` to Settings)

- [ ] **Step 1: Update Settings props and add Paths section**

Update `web/src/components/Settings.tsx` to accept paths and render the path list with edit/create/delete functionality:

Add to imports at top:

```typescript
import { api } from "../api/client";
import type { Tree, Status } from "../hooks/useTasks";
import PathEditor from "./PathEditor";
import { PipelinePreview } from "./Pipeline";
```

Update the Props interface:

```typescript
interface Props {
  trees: Tree[];
  status: Status | null;
  paths: Record<string, { description: string; steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }> }>;
  onRefresh: () => void;
}
```

Update the component signature:

```typescript
export default function Settings({ trees, status, paths, onRefresh }: Props) {
```

Add state for path editing after the existing state declarations (line ~22):

```typescript
  const [editingPath, setEditingPath] = useState<string | null>(null); // path name or "__new__"
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
```

Add the Paths section JSX between the Trees section and the Budget section. Insert before `{/* Budget */}`:

```tsx
      {/* Paths */}
      <section className="mb-8">
        <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Pipeline Paths</h3>

        {editingPath ? (
          <PathEditor
            name={editingPath === "__new__" ? null : editingPath}
            initial={editingPath !== "__new__" && paths[editingPath] ? {
              description: paths[editingPath].description,
              steps: paths[editingPath].steps.map(s => ({
                id: s.id,
                type: s.type as "worker" | "verdict",
                label: s.label || "",
                prompt: "",
                skills: [],
                sandbox: "read-write" as const,
                result_file: "",
                result_key: "",
                on_success: s.on_success || "",
                on_failure: s.on_failure || "",
                max_retries: 0,
              }))
            } : undefined}
            onSave={() => { setEditingPath(null); onRefresh(); }}
            onCancel={() => setEditingPath(null)}
          />
        ) : (
          <>
            <div className="space-y-2 mb-4">
              {Object.entries(paths).map(([name, path]) => (
                <div key={name} className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium text-sm">{name}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">{path.description}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setEditingPath(name)}
                        className="text-xs text-blue-400/70 hover:text-blue-400"
                      >Edit</button>
                      <button
                        onClick={async () => {
                          setDeletingPath(name);
                          try {
                            await api(`/api/paths/${encodeURIComponent(name)}`, { method: "DELETE" });
                            onRefresh();
                          } catch (err: any) {
                            alert(err.message);
                          } finally {
                            setDeletingPath(null);
                          }
                        }}
                        disabled={deletingPath === name}
                        className="text-xs text-red-400/60 hover:text-red-400 disabled:opacity-50"
                      >Delete</button>
                    </div>
                  </div>
                  <PipelinePreview steps={path.steps} />
                </div>
              ))}
              {Object.keys(paths).length === 0 && (
                <div className="text-zinc-600 text-sm">No paths configured.</div>
              )}
            </div>

            <button
              onClick={() => setEditingPath("__new__")}
              className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30"
            >
              New Path
            </button>
          </>
        )}
      </section>
```

- [ ] **Step 2: Pass paths prop from App.tsx to Settings**

In `web/src/App.tsx`, update both Settings render sites (desktop ~line 269, mobile ~line 172) to pass paths:

```tsx
          <Settings
            trees={taskState.trees}
            status={taskState.status}
            paths={taskState.paths}
            onRefresh={taskState.refresh}
          />
```

- [ ] **Step 3: Verify build succeeds**

Run: `cd /Users/peter/GitHub/bpamiri/grove && cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Settings.tsx web/src/App.tsx
git commit -m "feat: (W-062) integrate path list and editor into Settings page"
```

---

### Task 7: Full Path Data on Edit (Include Prompts)

**Files:**
- Modify: `src/broker/server.ts`

The existing `GET /api/paths` strips prompts for security. The editor needs full path data including prompts for editing. Add a detail endpoint.

- [ ] **Step 1: Add GET /api/paths/:name endpoint with full data**

Insert in `src/broker/server.ts` after the DELETE handler for paths:

```typescript
    // GET /api/paths/:name — full path config including prompts (for editor)
    if (pathUpdateMatch && req.method === "GET") {
      const name = decodeURIComponent(pathUpdateMatch[1]);
      const { configNormalizedPaths } = await import("./config");
      const all = configNormalizedPaths();
      if (!(name in all)) return json({ error: "Path not found" }, 404);
      return json({ name, ...all[name] });
    }
```

- [ ] **Step 2: Update PathEditor to fetch full data on edit**

In `web/src/components/PathEditor.tsx`, add a useEffect to fetch full path data when editing:

```typescript
  // Fetch full path data (including prompts) when editing
  useEffect(() => {
    if (!name) return;
    api<{ description: string; steps: any[] }>(`/api/paths/${encodeURIComponent(name)}`)
      .then(data => {
        setDescription(data.description);
        setSteps(data.steps.map((s: any) => ({
          id: s.id ?? "",
          type: s.type ?? "worker",
          label: s.label ?? "",
          prompt: s.prompt ?? "",
          skills: s.skills ?? [],
          sandbox: s.sandbox ?? "read-write",
          result_file: s.result_file ?? "",
          result_key: s.result_key ?? "",
          on_success: s.on_success === (data.steps[data.steps.indexOf(s) + 1]?.id ?? "$done") ? "" : (s.on_success ?? ""),
          on_failure: s.on_failure === "$fail" ? "" : (s.on_failure ?? ""),
          max_retries: s.max_retries ?? 0,
        })));
      })
      .catch(() => {}); // fall back to initial prop data
  }, [name]);
```

Remove the `initial` prop from `PathEditor` and from Settings' usage of it — the editor fetches its own data. Update Settings to just pass `name` and callbacks.

- [ ] **Step 3: Verify build succeeds**

Run: `cd /Users/peter/GitHub/bpamiri/grove && cd web && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/broker/server.ts web/src/components/PathEditor.tsx web/src/components/Settings.tsx
git commit -m "feat: (W-062) add full path detail endpoint and self-fetching editor"
```

---

### Task 8: Run All Tests and Verify

**Files:** None (verification only)

- [ ] **Step 1: Run all project tests**

Run: `cd /Users/peter/GitHub/bpamiri/grove && bun test`
Expected: All tests pass, including the new `server-paths.test.ts`.

- [ ] **Step 2: Run TypeScript type check**

Run: `cd /Users/peter/GitHub/bpamiri/grove && cd web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Build frontend**

Run: `cd /Users/peter/GitHub/bpamiri/grove/web && npx vite build`
Expected: Build succeeds.

- [ ] **Step 4: Fix any issues found, commit fixes**

If anything fails, fix and commit with: `fix: (W-062) <description>`

---

### Task 9: Session Summary

- [ ] **Step 1: Write session summary to `.grove/session-summary.md`**

Update the session summary with what was accomplished, files modified, and any remaining items.
