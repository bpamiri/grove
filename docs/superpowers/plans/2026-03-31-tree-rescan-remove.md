# Tree Rescan & Remove Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `grove tree rescan` and `grove tree remove` commands to re-detect GitHub remotes and unregister trees.

**Architecture:** CLI commands call broker API endpoints. Broker updates both SQLite DB and YAML config. Remove blocks by default if the tree has tasks; `--force` cascades.

**Tech Stack:** Bun, SQLite (bun:sqlite), YAML config, picocolors for CLI output

---

### Task 1: Add `treeDelete` and `taskDeleteByTree` to Database

**Files:**
- Modify: `src/broker/db.ts:102-125` (tree helpers section)
- Test: `tests/broker/db.test.ts`

- [ ] **Step 1: Write failing test for `treeDelete`**

In `tests/broker/db.test.ts`, add to the `"Tree operations"` describe block:

```typescript
test("treeDelete removes a tree", () => {
  db.treeUpsert({ id: "doomed", name: "Doomed", path: "/tmp/doomed" });
  expect(db.treeGet("doomed")).not.toBeNull();
  db.treeDelete("doomed");
  expect(db.treeGet("doomed")).toBeNull();
});

test("treeDelete is idempotent for missing tree", () => {
  // Should not throw
  db.treeDelete("nonexistent");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/broker/db.test.ts`
Expected: FAIL — `db.treeDelete is not a function`

- [ ] **Step 3: Implement `treeDelete`**

In `src/broker/db.ts`, after the `allTrees()` method (line ~125), add:

```typescript
treeDelete(id: string): void {
  this.run("DELETE FROM trees WHERE id = ?", [id]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/broker/db.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for `taskDeleteByTree`**

In `tests/broker/db.test.ts`, add to the `"Task operations"` describe block:

```typescript
test("taskDeleteByTree removes all tasks for a tree", () => {
  db.treeUpsert({ id: "my-tree", name: "My Tree", path: "/tmp/tree" });
  db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-001", "my-tree", "Task A", "draft"]);
  db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-002", "my-tree", "Task B", "active"]);
  db.run("INSERT INTO tasks (id, tree_id, title, status) VALUES (?, ?, ?, ?)", ["W-003", "other", "Task C", "draft"]);

  const count = db.taskDeleteByTree("my-tree");
  expect(count).toBe(2);
  expect(db.tasksByTree("my-tree").length).toBe(0);
  // Other tree's tasks unaffected
  expect(db.taskGet("W-003")).not.toBeNull();
});

test("taskDeleteByTree returns 0 when no tasks", () => {
  const count = db.taskDeleteByTree("empty-tree");
  expect(count).toBe(0);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/broker/db.test.ts`
Expected: FAIL — `db.taskDeleteByTree is not a function`

- [ ] **Step 7: Implement `taskDeleteByTree`**

In `src/broker/db.ts`, after `treeDelete`, add:

```typescript
taskDeleteByTree(treeId: string): number {
  const before = this.scalar<number>("SELECT COUNT(*) FROM tasks WHERE tree_id = ?", [treeId]) ?? 0;
  this.run("DELETE FROM tasks WHERE tree_id = ?", [treeId]);
  return before;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/broker/db.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/broker/db.ts tests/broker/db.test.ts
git commit -m "feat: add treeDelete and taskDeleteByTree to database (#107)"
```

---

### Task 2: Add `configDeleteTree` to config module

**Files:**
- Modify: `src/broker/config.ts:60-79` (after `configSet`)
- Test: `tests/broker/db.test.ts` (reuse existing test infra, or inline verification in Task 4 API tests)

- [ ] **Step 1: Implement `configDeleteTree`**

In `src/broker/config.ts`, after the `configSet` function (line ~79), add:

```typescript
export function configDeleteTree(treeId: string): void {
  const { GROVE_CONFIG } = getEnv();
  const config = loadConfig();
  if (config.trees && config.trees[treeId]) {
    delete config.trees[treeId];
    writeFileSync(GROVE_CONFIG, stringifyYaml(config));
    _config = config;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/broker/config.ts
git commit -m "feat: add configDeleteTree for YAML config removal (#107)"
```

---

### Task 3: Add API endpoints — `POST /api/trees/:id/rescan` and `DELETE /api/trees/:id`

**Files:**
- Modify: `src/broker/server.ts:436-451` (after existing POST /api/trees)
- Modify: `src/broker/config.ts` (import configDeleteTree — already exported from Task 2)

- [ ] **Step 1: Add rescan endpoint**

In `src/broker/server.ts`, after the `POST /api/trees` block (around line 451), add:

```typescript
// POST /api/trees/:id/rescan — re-detect GitHub remote
const rescanMatch = path.match(/^\/api\/trees\/([^/]+)\/rescan$/);
if (rescanMatch && req.method === "POST") {
  const tree = db.treeGet(rescanMatch[1]);
  if (!tree) return json({ error: "Tree not found" }, 404);

  const oldGithub = tree.github;
  const newGithub = detectGithubRemote(tree.path);
  db.treeUpsert({ ...tree, github: newGithub ?? undefined });

  // Sync YAML config
  const { configSet } = await import("./config");
  if (newGithub) {
    configSet(`trees.${tree.id}.github`, newGithub);
  }

  db.addEvent(null, null, "tree_rescan", `Rescanned ${tree.id}: github ${oldGithub ?? "null"} → ${newGithub ?? "null"}`);
  return json({ ...db.treeGet(tree.id), old_github: oldGithub });
}
```

- [ ] **Step 2: Add remove endpoint**

Immediately after the rescan block, add:

```typescript
// DELETE /api/trees/:id — remove a tree (blocks if tasks exist unless ?force=true)
const deleteTreeMatch = path.match(/^\/api\/trees\/([^/]+)$/);
if (deleteTreeMatch && req.method === "DELETE") {
  const tree = db.treeGet(deleteTreeMatch[1]);
  if (!tree) return json({ error: "Tree not found" }, 404);

  const tasks = db.tasksByTree(tree.id);
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  if (tasks.length > 0 && !force) {
    return json({ error: "Tree has tasks", task_count: tasks.length }, 409);
  }

  const deletedTasks = tasks.length > 0 ? db.taskDeleteByTree(tree.id) : 0;
  db.treeDelete(tree.id);

  // Remove from YAML config
  const { configDeleteTree } = await import("./config");
  configDeleteTree(tree.id);

  db.addEvent(null, null, "tree_removed", `Removed tree ${tree.id} (${deletedTasks} tasks deleted)`);
  return json({ ok: true, tree: tree.id, tasks_deleted: deletedTasks });
}
```

- [ ] **Step 3: Run existing tests to check for regressions**

Run: `bun test`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/broker/server.ts
git commit -m "feat: add rescan and delete API endpoints for trees (#107)"
```

---

### Task 4: Add CLI commands — `grove tree rescan` and `grove tree remove`

**Files:**
- Modify: `src/cli/commands/trees.ts`

- [ ] **Step 1: Add rescan and remove command routing**

In `src/cli/commands/trees.ts`, update the `run` function to route the new subcommands. Replace the existing `run` function:

```typescript
export async function run(args: string[]) {
  // grove tree add <path> [--github org/repo] [--name name]
  if (args[0] === "add" || (args[0] === "tree" && args[1] === "add")) {
    const addArgs = args[0] === "add" ? args.slice(1) : args.slice(2);
    await addTree(addArgs);
    return;
  }

  // grove tree rescan <name>
  if (args[0] === "rescan" || (args[0] === "tree" && args[1] === "rescan")) {
    const rescanArgs = args[0] === "rescan" ? args.slice(1) : args.slice(2);
    await rescanTree(rescanArgs);
    return;
  }

  // grove tree remove <name> [--force]
  if (args[0] === "remove" || (args[0] === "tree" && args[1] === "remove")) {
    const removeArgs = args[0] === "remove" ? args.slice(1) : args.slice(2);
    await removeTree(removeArgs);
    return;
  }

  // grove trees — list
  const trees = configTrees();
  const entries = Object.entries(trees);

  if (entries.length === 0) {
    console.log(`${pc.yellow("No trees configured.")}`);
    console.log(`Add one with: ${pc.bold("grove tree add ~/path/to/repo")}`);
    return;
  }

  console.log(`${pc.bold("Trees")} (${entries.length})`);
  console.log();

  for (const [id, tree] of entries) {
    const github = tree.github ? pc.dim(` (${tree.github})`) : "";
    const path = expandHome(tree.path);
    const exists = existsSync(path);
    const pathStatus = exists ? pc.green(path) : pc.red(`${path} (not found)`);

    console.log(`  ${pc.green(id)}${github}`);
    console.log(`    ${pc.dim("path:")} ${pathStatus}`);
    if (tree.branch_prefix) console.log(`    ${pc.dim("prefix:")} ${tree.branch_prefix}`);
  }
}
```

- [ ] **Step 2: Add the `rescanTree` function**

Add after the `addTree` function in `src/cli/commands/trees.ts`:

```typescript
async function rescanTree(args: string[]) {
  const { readBrokerInfo } = await import("../../broker/index");
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const treeId = args.find(a => !a.startsWith("--"));
  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove tree rescan <name>`);
    return;
  }

  try {
    const resp = await fetch(`${info.url}/api/trees/${encodeURIComponent(treeId)}/rescan`, {
      method: "POST",
    });

    if (resp.status === 404) {
      console.log(`${pc.red("Tree not found:")} ${treeId}`);
      return;
    }

    const data = await resp.json() as any;
    const oldGithub = data.old_github ?? "null";
    const newGithub = data.github ?? "null";
    console.log(`${pc.green("✓")} Rescanned ${pc.bold(treeId)}`);
    console.log(`  github: ${newGithub}${oldGithub !== newGithub ? pc.dim(` (was: ${oldGithub})`) : ""}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
```

- [ ] **Step 3: Add the `removeTree` function**

Add after `rescanTree`:

```typescript
async function removeTree(args: string[]) {
  const { readBrokerInfo } = await import("../../broker/index");
  const info = readBrokerInfo();
  if (!info) {
    console.log(`${pc.yellow("Grove is not running.")} Run ${pc.bold("grove up")} first.`);
    return;
  }

  const force = args.includes("--force");
  const treeId = args.find(a => !a.startsWith("--"));
  if (!treeId) {
    console.log(`${pc.red("Usage:")} grove tree remove <name> [--force]`);
    return;
  }

  try {
    const url = `${info.url}/api/trees/${encodeURIComponent(treeId)}${force ? "?force=true" : ""}`;
    const resp = await fetch(url, { method: "DELETE" });

    if (resp.status === 404) {
      console.log(`${pc.red("Tree not found:")} ${treeId}`);
      return;
    }

    if (resp.status === 409) {
      const data = await resp.json() as any;
      console.log(`${pc.red("✘")} Tree ${pc.bold(`"${treeId}"`)} has ${data.task_count} tasks. Use ${pc.bold("--force")} to remove the tree and all its tasks.`);
      return;
    }

    const data = await resp.json() as any;
    const suffix = data.tasks_deleted > 0 ? ` (${data.tasks_deleted} tasks deleted)` : "";
    console.log(`${pc.green("✓")} Removed tree ${pc.bold(`"${treeId}"`)}${suffix}`);
  } catch (err: any) {
    console.log(`${pc.red("Error:")} ${err.message}`);
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/trees.ts
git commit -m "feat: add grove tree rescan and grove tree remove CLI commands (#107)"
```

---

### Task 5: Update help text

**Files:**
- Modify: `src/cli/commands/help.ts`
- Modify: `src/cli/index.ts` (if needed — already has `tree` alias)

- [ ] **Step 1: Update help.ts**

In `src/cli/commands/help.ts`, add the new commands to the setup section. Replace the `tree add` line area:

```typescript
${pc.bold("Trees:")}
  ${pc.green("trees")}             List configured trees (repos)
  ${pc.green("tree add")} <path>   Add a new tree
  ${pc.green("tree rescan")} <name>  Re-detect GitHub remote for a tree
  ${pc.green("tree remove")} <name>  Remove a tree from Grove
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/help.ts
git commit -m "docs: add tree rescan/remove to help output (#107)"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Build and verify**

Run: `bun run build` (or however the project builds — check package.json)

- [ ] **Step 2: Test rescan with running broker**

```bash
grove up
grove tree rescan grove
```

Expected: Shows updated github field (or confirms it's unchanged).

- [ ] **Step 3: Test remove block**

```bash
grove tree remove grove
```

Expected: Shows error with task count and `--force` hint.

- [ ] **Step 4: Test remove with force on a test tree**

```bash
grove tree add /tmp/test-repo --name test-tree
grove tree remove test-tree
```

Expected: Removes cleanly (no tasks).

- [ ] **Step 5: Final commit if any fixups needed**

Only if smoke testing revealed issues that need fixing.
