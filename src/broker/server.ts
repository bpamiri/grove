// Grove v3 — Bun HTTP + WebSocket server with REST API and static file serving
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Database } from "./db";
import { bus } from "./event-bus";
import { GROVE_VERSION, type EventBusMap } from "../shared/types";
import { EMBEDDED_ASSETS } from "./web-assets.generated";
import { startSeedSession, sendSeedMessage, stopSeedSession, isSeedSessionActive, setSeedBroadcast, createSeedBranch, switchSeedBranch } from "./seed-session";
import { ActivityRingBuffer, type ActivityEvent } from "./ring-buffer";
import { BatchedBroadcaster } from "./batched-broadcaster";
import { detectCycle, type DagEdge } from "../batch/dag";
import { detectGithubRemote } from "../shared/github";

export interface ServerOptions {
  db: Database;
  port: number;
  onChat?: (text: string) => void;
  staticDir?: string; // Path to web/dist/ for serving React SPA
}

interface WSData {
  authenticated: boolean;
}

let server: ReturnType<typeof Bun.serve<WSData>> | null = null;
const wsClients = new Set<{ send(data: string): void }>();
let _remoteUrl: string | null = null;

const activityBuffer = new ActivityRingBuffer(100);

const BATCHED_EVENTS = new Set([
  "agent:tool_use", "agent:thinking", "agent:text", "agent:cost",
]);

let broadcaster: BatchedBroadcaster | null = null;

/** Set the tunnel URL (called after tunnel starts) */
export function setRemoteUrl(url: string | null): void {
  _remoteUrl = url;
}

function broadcastRaw(msg: string) {
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

// Broadcast a message to all connected WebSocket clients
function broadcast(type: string, data: any) {
  // Store activity events in ring buffer
  if (BATCHED_EVENTS.has(type) && data?.taskId) {
    activityBuffer.push(data.taskId, { type, ...data } as ActivityEvent);
  }

  // Batch high-frequency events, send others immediately
  if (broadcaster && BATCHED_EVENTS.has(type)) {
    broadcaster.queue(type, data);
  } else {
    broadcastRaw(JSON.stringify({ type, data, ts: Date.now() }));
  }
}

// Subscribe to event bus and broadcast to WS clients
function wireEventBus(db: Database) {
  const forward = <K extends keyof EventBusMap>(event: K) =>
    bus.on(event, (data) => broadcast(event, data));

  forward("task:created");
  forward("task:updated");
  forward("task:status");
  forward("worker:spawned");
  forward("worker:ended");
  forward("worker:activity");
  forward("eval:started");
  forward("eval:passed");
  forward("eval:failed");
  forward("gate:result");
  forward("merge:pr_created");
  forward("merge:ci_passed");
  forward("merge:ci_failed");
  forward("merge:completed");
  forward("cost:updated");
  forward("cost:budget_warning");
  forward("monitor:stall");
  forward("monitor:crash");
  forward("message:new");

  // SAP events (fine-grained agent activity)
  forward("agent:spawned");
  forward("agent:ended");
  forward("agent:crashed");
  forward("agent:tool_use");
  forward("agent:thinking");
  forward("agent:text");
  forward("agent:cost");

  // Persist SAP activity events for observability dashboard
  bus.on("agent:tool_use", (data) => {
    db.addEvent(data.taskId, data.agentId, "agent:tool_use", `${data.tool}: ${data.input}`);
  });
  bus.on("agent:thinking", (data) => {
    db.addEvent(data.taskId, data.agentId, "agent:thinking", data.snippet);
  });

  // SAP seed events
  forward("seed:response");
  forward("seed:chunk");
  forward("seed:complete");
  forward("seed:idle");

  // Skill management events
  forward("skill:installed");
  forward("skill:removed");

  // Clear ring buffer when worker finishes
  bus.on("worker:ended", (data) => {
    activityBuffer.clear(data.taskId);
  });
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function startServer(opts: ServerOptions) {
  const { db, port, onChat, staticDir } = opts;

  wireEventBus(db);
  broadcaster = new BatchedBroadcaster(100, broadcastRaw);
  setSeedBroadcast(broadcast);

  server = Bun.serve<WSData>({
    port,

    fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      // WebSocket upgrade — local connections are pre-authenticated
      if (path === "/ws") {
        const isLocal = !isRemoteRequest(req);
        const upgraded = server.upgrade(req, { data: { authenticated: isLocal } });
        if (upgraded) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes — require auth token for remote (non-localhost) requests
      if (path.startsWith("/api/")) {
        if (isRemoteRequest(req) && !isAuthorized(req)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        return handleApi(path, req, db, onChat, corsHeaders);
      }

      // Static file serving (React SPA) — filesystem first, then embedded assets
      if (staticDir && existsSync(staticDir)) {
        return serveStatic(path, staticDir, corsHeaders);
      }

      return serveEmbedded(path, corsHeaders);
    },

    websocket: {
      open(ws) {
        wsClients.add(ws);
      },
      message(ws, message) {
        try {
          const data = JSON.parse(String(message));

          // Handle auth
          if (data.type === "auth") {
            const { validateToken } = require("./auth");
            ws.data.authenticated = validateToken(data.token);
            ws.send(JSON.stringify({
              type: "auth_result",
              authenticated: ws.data.authenticated,
            }));
            return;
          }

          // Require auth for write operations
          if (!ws.data.authenticated && data.type !== "auth") {
            ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
            return;
          }

          // Handle chat messages from GUI
          if (data.type === "chat" && data.text) {
            db.addMessage("user", data.text);
            bus.emit("message:new", {
              message: {
                id: 0,
                source: "user",
                channel: "main",
                content: data.text,
                created_at: new Date().toISOString(),
              },
            });
            onChat?.(data.text);
            return;
          }

          // Handle task actions from GUI
          if (data.type === "action") {
            handleWsAction(data, db);
            return;
          }

          // Handle seed session messages
          if (data.type === "seed" && data.taskId && data.text) {
            sendSeedMessage(data.taskId, data.text, db);
            return;
          }

          if (data.type === "seed_start" && data.taskId) {
            const task = db.taskGet(data.taskId);
            if (!task || !task.tree_id) return;
            const tree = db.treeGet(task.tree_id);
            if (!tree) return;
            const { getEnv } = require("./db");
            startSeedSession(task, tree, db, getEnv().GROVE_LOG_DIR);
            return;
          }

          if (data.type === "seed_stop" && data.taskId) {
            stopSeedSession(data.taskId, db);
            return;
          }

          if (data.type === "seed_branch" && data.taskId) {
            createSeedBranch(data.taskId, data.parentMessageIndex, data.label);
            return;
          }

          if (data.type === "seed_switch_branch" && data.taskId) {
            switchSeedBranch(data.taskId, data.branchId);
            return;
          }
        } catch {
          // Invalid message
        }
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });

  bus.emit("broker:started", { port, url: `http://localhost:${port}` });

  return server;
}

export function stopServer(): void {
  broadcaster?.stop();
  broadcaster = null;
  server?.stop();
  server = null;
  wsClients.clear();
}

/** Get connected WebSocket client count */
export function wsClientCount(): number {
  return wsClients.size;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(path: string, staticDir: string, corsHeaders: Record<string, string>): Response {
  // Try the exact path first
  let filePath = join(staticDir, path === "/" ? "index.html" : path);

  if (existsSync(filePath)) {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": contentType, ...corsHeaders },
    });
  }

  // SPA fallback: serve index.html for all non-file routes
  const indexPath = join(staticDir, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { "Content-Type": "text/html", ...corsHeaders },
    });
  }

  return new Response("Not Found", { status: 404 });
}

function serveEmbedded(path: string, corsHeaders: Record<string, string>): Response {
  const key = path === "/" ? "/index.html" : path;
  const asset = EMBEDDED_ASSETS[key];
  if (asset) {
    return new Response(asset.data, {
      headers: { "Content-Type": asset.contentType, ...corsHeaders },
    });
  }

  // SPA fallback: serve index.html for client-side routes
  const index = EMBEDDED_ASSETS["/index.html"];
  if (index) {
    return new Response(index.data, {
      headers: { "Content-Type": "text/html", ...corsHeaders },
    });
  }

  return new Response(JSON.stringify({ name: "grove", version: "3.0.0-alpha.0", status: "running" }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ---------------------------------------------------------------------------
// WebSocket action handler
// ---------------------------------------------------------------------------

function handleWsAction(data: any, db: Database) {
  switch (data.action) {
    case "pause_task": {
      const { stopWorker } = require("../agents/worker");
      stopWorker(data.taskId, db);
      break;
    }
    case "cancel_task": {
      db.taskSetStatus(data.taskId, "failed");
      const { stopWorker } = require("../agents/worker");
      stopWorker(data.taskId, db);
      break;
    }
    case "close_task": {
      const task = db.taskGet(data.taskId);
      if (!task) break;
      if (task.status !== "draft" && task.status !== "failed") break;
      db.taskSetStatus(data.taskId, "closed");
      break;
    }
    case "resume_task": {
      const task = db.taskGet(data.taskId);
      if (!task || task.status === "completed") break;
      if (task.status === "active" && !task.paused) {
        const { stopWorker } = require("../agents/worker");
        stopWorker(data.taskId, db);
      }
      const step = data.step;
      if (step) {
        const { configNormalizedPaths } = require("./config");
        const paths = configNormalizedPaths();
        const pathConfig = paths[task.path_name];
        if (!pathConfig) break;
        const targetStep = pathConfig.steps.find((s: any) => s.id === step);
        if (!targetStep) break;
        const stepIndex = pathConfig.steps.indexOf(targetStep);
        db.run("UPDATE tasks SET current_step = ?, step_index = ? WHERE id = ?", [step, stepIndex, data.taskId]);
      }
      db.run("UPDATE tasks SET status = 'queued', retry_count = 0, paused = 0 WHERE id = ?", [data.taskId]);
      db.addEvent(data.taskId, null, "task_resume_requested", `Resume requested at step "${step ?? task.current_step ?? "current"}"`);
      const { enqueue } = require("./dispatch");
      enqueue(data.taskId);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// REST API handler
// ---------------------------------------------------------------------------

async function handleApi(
  path: string,
  req: Request,
  db: Database,
  onChat: ((text: string) => void) | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  try {
    // GET /api/status
    if (path === "/api/status" && req.method === "GET") {
      const { activeWorkerCount } = await import("../agents/worker");
      const { isRunning } = await import("../agents/orchestrator");
      const { queueLength } = await import("./dispatch");
      const { isSpawningPaused } = await import("../monitor/cost");
      return json({
        version: GROVE_VERSION,
        broker: "running",
        remoteUrl: _remoteUrl,
        orchestrator: isRunning() ? "running" : "stopped",
        workers: activeWorkerCount(),
        queue: queueLength(),
        spawningPaused: isSpawningPaused(),
        wsClients: wsClients.size,
        tasks: {
          total: db.taskCount(),
          active: db.taskCount("active"),
          completed: db.taskCount("completed"),
          draft: db.taskCount("draft"),
        },
        cost: {
          today: db.costToday(),
          week: db.costWeek(),
        },
      });
    }

    // GET /api/trees — enrich with parsed config fields (default_path, default_branch)
    if (path === "/api/trees" && req.method === "GET") {
      const rawTrees = db.allTrees();
      const enriched = rawTrees.map(t => {
        const cfg = JSON.parse(t.config || "{}");
        return { ...t, default_path: cfg.default_path ?? null, default_branch: cfg.default_branch ?? null };
      });
      return json(enriched);
    }

    // POST /api/trees
    if (path === "/api/trees" && req.method === "POST") {
      const body = await req.json() as { id?: string; path: string; github?: string; branch_prefix?: string };
      if (!body.path) return json({ error: "path required" }, 400);
      const { basename } = await import("node:path");
      const id = body.id ?? basename(body.path).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const github = body.github ?? detectGithubRemote(body.path) ?? undefined;
      db.treeUpsert({
        id,
        name: id,
        path: body.path,
        github,
        branch_prefix: body.branch_prefix ?? "grove/",
      });
      return json(db.treeGet(id), 201);
    }

    // POST /api/trees/:id/rescan — re-detect GitHub remote
    const rescanMatch = path.match(/^\/api\/trees\/([^/]+)\/rescan$/);
    if (rescanMatch && req.method === "POST") {
      const tree = db.treeGet(rescanMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);

      const oldGithub = tree.github;
      const newGithub = detectGithubRemote(tree.path);
      db.treeUpsert({ ...tree, github: newGithub ?? undefined });

      // Sync YAML config
      const { configSet, configUnset } = await import("./config");
      if (newGithub) {
        configSet(`trees.${tree.id}.github`, newGithub);
      } else {
        configUnset(`trees.${tree.id}.github`);
      }

      db.addEvent(null, null, "tree_rescan", `Rescanned ${tree.id}: github ${oldGithub ?? "null"} → ${newGithub ?? "null"}`);
      return json({ ...db.treeGet(tree.id), old_github: oldGithub });
    }

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

      // Clean up any worktrees on disk before removing the tree
      // Use readdirSync instead of listWorktrees — works even if repo is gone
      try {
        const { readdirSync, statSync } = await import("node:fs");
        const { cleanupWorktree, expandHome } = await import("../shared/worktree");
        const worktreeDir = join(expandHome(tree.path), ".grove", "worktrees");
        if (existsSync(worktreeDir)) {
          for (const entry of readdirSync(worktreeDir)) {
            if (statSync(join(worktreeDir, entry)).isDirectory()) {
              cleanupWorktree(entry, tree.path);
            }
          }
        }
      } catch { /* best-effort */ }

      db.treeDelete(tree.id);

      // Remove from YAML config
      const { configDeleteTree } = await import("./config");
      configDeleteTree(tree.id);

      db.addEvent(null, null, "tree_removed", `Removed tree ${tree.id} (${deletedTasks} tasks deleted)`);
      return json({ ok: true, tree: tree.id, tasks_deleted: deletedTasks });
    }

    // POST /api/cleanup/worktrees — prune stale worktrees
    if (path === "/api/cleanup/worktrees" && req.method === "POST") {
      const { pruneStaleWorktrees } = await import("../shared/worktree");
      const result = pruneStaleWorktrees(db);
      return json(result);
    }

    // GET /api/trees/:id/issues — fetch open GitHub issues for a tree
    const issuesMatch = path.match(/^\/api\/trees\/([^/]+)\/issues$/);
    if (issuesMatch && req.method === "GET") {
      const tree = db.treeGet(issuesMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json([]);
      try {
        const { ghIssueList } = await import("../shared/github");
        const issues = ghIssueList(tree.github, { state: "open", limit: 30 });
        return json(issues);
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/paths — normalized pipeline step definitions
    if (path === "/api/paths" && req.method === "GET") {
      const { configNormalizedPathsForApi } = await import("./config");
      return json(configNormalizedPathsForApi());
    }

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
      configSetPath(body.name, { description: body.description!, steps: body.steps! });
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

    // DELETE /api/paths/:name — remove a path (prevent deleting built-in defaults)
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

    // GET /api/paths/:name — full path config including prompts (for editor)
    if (pathUpdateMatch && req.method === "GET") {
      const name = decodeURIComponent(pathUpdateMatch[1]);
      const { configNormalizedPaths } = await import("./config");
      const all = configNormalizedPaths();
      if (!(name in all)) return json({ error: "Path not found" }, 404);
      return json({ name, ...all[name] });
    }

    // POST /api/trees/:id/import-issues — create tasks from open GitHub issues
    const importMatch = path.match(/^\/api\/trees\/([^/]+)\/import-issues$/);
    if (importMatch && req.method === "POST") {
      const tree = db.treeGet(importMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json({ error: "No GitHub repo configured" }, 400);

      try {
        const { ghIssueList } = await import("../shared/github");
        const issues = ghIssueList(tree.github, { state: "open", limit: 50 });

        // Sort by issue number ascending so tasks are created in chronological order
        issues.sort((a, b) => a.number - b.number);

        // Find issues that already have tasks (by github_issue column)
        const existingIssueNums = new Set<number>(
          db.all<{ github_issue: number }>(
            "SELECT github_issue FROM tasks WHERE tree_id = ? AND github_issue IS NOT NULL",
            [tree.id]
          ).map(r => r.github_issue)
        );

        // Resolve tree's default path for imported tasks
        const treeConfig = JSON.parse(tree.config || "{}");
        const treePath = treeConfig.default_path ?? "development";

        let imported = 0;
        for (const issue of issues) {
          if (existingIssueNums.has(issue.number)) continue;

          const taskId = db.nextTaskId("W");
          const title = `${issue.title} Issue #${issue.number}`;
          const description = issue.body || "";
          const labels = issue.labels?.map((l: any) => l.name).join(",") || null;
          db.run(
            "INSERT INTO tasks (id, tree_id, title, description, path_name, status, github_issue, labels) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)",
            [taskId, tree.id, title, description, treePath, issue.number, labels]
          );
          db.addEvent(taskId, null, "task_created", `Imported from ${tree.github}#${issue.number}`);
          imported++;
        }

        return json({ ok: true, imported, skipped: issues.length - imported, total: issues.length });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /api/trees/:id/import-prs — create tasks from open contributed PRs
    const importPrsMatch = path.match(/^\/api\/trees\/([^/]+)\/import-prs$/);
    if (importPrsMatch && req.method === "POST") {
      const tree = db.treeGet(importPrsMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json({ error: "No GitHub repo configured" }, 400);

      try {
        const { ghPrList } = await import("../shared/github");
        const { filterExternalPRs, importPr } = await import("../pr/poller");
        const prs = ghPrList(tree.github, { state: "open", limit: 50 });
        const external = filterExternalPRs(prs, tree.branch_prefix);

        let imported = 0;
        for (const pr of external) {
          const taskId = importPr(db, tree, pr);
          if (taskId) imported++;
        }

        return json({ ok: true, imported, skipped: external.length - imported, total: prs.length, external: external.length });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/tasks
    if (path === "/api/tasks" && req.method === "GET") {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const tree = url.searchParams.get("tree");

      let tasks;
      if (tree) tasks = db.tasksByTree(tree);
      else if (status) tasks = db.tasksByStatus(status);
      else tasks = db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50");

      // Annotate tasks with seed status
      const seedStatuses = db.all<{ task_id: string; status: string }>(
        "SELECT task_id, status FROM seeds WHERE status IN ('active', 'completed')"
      );
      const seedMap = new Map(seedStatuses.map(s => [s.task_id, s.status]));
      const annotated = (tasks as any[]).map(t => ({
        ...t,
        has_seed: seedMap.has(t.id),
        seed_status: seedMap.get(t.id) ?? null,
      }));

      return json(annotated);
    }

    // GET /api/tasks/:id
    const taskMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)$/);
    if (taskMatch && req.method === "GET") {
      const task = db.taskGet(taskMatch[1]);
      if (!task) return json({ error: "Task not found" }, 404);
      const events = db.eventsByTask(task.id);
      const subtasks = db.subTasks(task.id);
      return json({ ...task, events, subtasks });
    }

    // POST /api/tasks
    if (path === "/api/tasks" && req.method === "POST") {
      const body = await req.json() as {
        title: string; tree_id?: string; description?: string; path_name?: string;
        priority?: number; depends_on?: string; parent_task_id?: string; max_retries?: number;
        github_issue?: number; labels?: string; skill_overrides?: string;
      };
      // Resolve path: explicit override → tree's default_path → "development"
      let resolvedPath = body.path_name;
      if (!resolvedPath && body.tree_id) {
        const tree = db.treeGet(body.tree_id);
        if (tree) {
          const treeConfig = JSON.parse(tree.config || "{}");
          resolvedPath = treeConfig.default_path;
        }
      }
      const taskId = db.nextTaskId("W");
      db.run(
        `INSERT INTO tasks (id, tree_id, title, description, path_name, priority, depends_on, parent_task_id, max_retries, github_issue, labels, skill_overrides, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [
          taskId, body.tree_id ?? null, body.title, body.description ?? null,
          resolvedPath ?? "development", body.priority ?? 0,
          body.depends_on ?? null, body.parent_task_id ?? null,
          body.max_retries ?? 2, body.github_issue ?? null,
          body.labels ?? null, body.skill_overrides ?? null,
        ],
      );
      db.addEvent(taskId, null, "task_created", `Task created: ${body.title}`);
      const task = db.taskGet(taskId);
      bus.emit("task:created", { task: task! });
      return json(task, 201);
    }

    // PATCH /api/tasks/:id — update editable fields
    const patchMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)$/);
    if (patchMatch && req.method === "PATCH") {
      const taskId = patchMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);

      const body = await req.json() as Record<string, unknown>;
      // Draft tasks: all editable fields. Active/completed: only title + description.
      const draftFields = ["title", "description", "tree_id", "path_name", "priority", "depends_on", "parent_task_id", "max_retries", "github_issue", "labels", "skill_overrides"];
      const limitedFields = ["title", "description"];
      const allowed = task.status === "draft" ? draftFields : limitedFields;

      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const field of allowed) {
        if (field in body) {
          sets.push(`${field} = ?`);
          vals.push(body[field] ?? null);
        }
      }
      if (sets.length === 0) return json({ error: "No valid fields to update" }, 400);
      vals.push(taskId);
      db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);
      db.addEvent(taskId, null, "task_updated", `Task updated: ${sets.map(s => s.split(" ")[0]).join(", ")}`);
      const updated = db.taskGet(taskId);
      bus.emit("task:status", { taskId, status: updated!.status });

      // Two-way sync: push title/description changes to linked GitHub issue
      if (updated?.github_issue && updated.tree_id && ("title" in body || "description" in body)) {
        const tree = db.treeGet(updated.tree_id);
        if (tree?.github) {
          try {
            const { ghIssueEdit } = await import("../shared/github");
            const editOpts: { title?: string; body?: string } = {};
            if ("title" in body) editOpts.title = String(body.title);
            if ("description" in body) editOpts.body = String(body.description ?? "");
            ghIssueEdit(tree.github, updated.github_issue, editOpts);
            db.addEvent(taskId, null, "issue_synced", `GitHub issue #${updated.github_issue} updated`);
          } catch (err: any) {
            db.addEvent(taskId, null, "issue_sync_failed", `Failed to sync GitHub issue: ${err.message}`);
          }
        }
      }

      return json(updated);
    }

    // POST /api/chat
    if (path === "/api/chat" && req.method === "POST") {
      const body = await req.json() as { text: string };
      if (!body.text) return json({ error: "text required" }, 400);

      db.addMessage("user", body.text);
      bus.emit("message:new", {
        message: { id: 0, source: "user", channel: "main", content: body.text, created_at: new Date().toISOString() },
      });
      onChat?.(body.text);
      return json({ ok: true });
    }

    // DELETE /api/tasks/:id — hard-delete a draft task
    const deleteMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const taskId = deleteMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      if (task.status !== "draft") return json({ error: "Only draft tasks can be deleted" }, 400);
      db.taskDelete(taskId);
      db.addEvent(null, null, "task_deleted", `Deleted draft task ${taskId}`);
      return json({ ok: true });
    }

    // POST /api/tasks/:id/dispatch — promote to ready and enqueue
    const dispatchMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/dispatch$/);
    if (dispatchMatch && req.method === "POST") {
      const taskId = dispatchMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);

      // Deferred GitHub issue creation: if task has a tree but no issue yet, create one now
      if (!task.github_issue && task.tree_id) {
        const { createIssueForTask } = await import("./github-sync");
        const { ghIssueCreate } = await import("../shared/github");
        createIssueForTask(db, taskId, ghIssueCreate);
      }

      // Leave current_step null — startPipeline sets it (including seed-skip logic)
      db.taskSetStatus(taskId, "queued");
      const { enqueue } = await import("./dispatch");
      enqueue(taskId);
      return json({ ok: true, taskId, status: "queued" });
    }

    // GET /api/tasks/:id/activity/live — ring buffer catch-up for active tasks
    const liveActivityMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/activity\/live$/);
    if (liveActivityMatch && req.method === "GET") {
      const taskId = liveActivityMatch[1];
      const events = activityBuffer.get(taskId);
      return json(events);
    }

    // GET /api/tasks/:id/activity — recent tool_use activity from worker log
    const activityMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/activity$/);
    if (activityMatch && req.method === "GET") {
      const taskId = activityMatch[1];
      try {
        const { existsSync, readFileSync, readdirSync } = await import("node:fs");
        const { getEnv } = await import("./db");
        const logDir = getEnv().GROVE_LOG_DIR;

        // Find worker log by filename convention: worker-{taskId}-*.jsonl
        const prefix = `worker-${taskId}-`;
        const files = readdirSync(logDir).filter(f => f.startsWith(prefix) && f.endsWith(".jsonl"));
        if (files.length === 0) return json([]);

        // Use the most recent log file
        const logPath = join(logDir, files.sort().pop()!);
        if (!existsSync(logPath)) return json([]);

        const content = readFileSync(logPath, "utf-8");
        const activities: Array<{ ts: string; msg: string }> = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // stream-json nests tool_use in assistant message content blocks
            if (obj.type === "assistant") {
              for (const block of obj.message?.content ?? []) {
                if (block.type === "tool_use") {
                  const name = block.name ?? "tool";
                  const inp = block.input ?? {};
                  const detail = typeof inp === "object"
                    ? (inp.file_path ?? inp.command ?? inp.pattern ?? "").toString().slice(0, 200)
                    : "";
                  activities.push({ ts: obj.timestamp ?? "", msg: `${name}: ${detail}`, kind: "tool" });
                } else if (block.type === "thinking" && block.thinking) {
                  const snippet = block.thinking.slice(0, 300).replace(/\n/g, " ");
                  activities.push({ ts: obj.timestamp ?? "", msg: `thinking: ${snippet}`, kind: "thinking" });
                } else if (block.type === "text" && block.text && block.text.length > 10) {
                  const snippet = block.text.slice(0, 300).replace(/\n/g, " ");
                  activities.push({ ts: obj.timestamp ?? "", msg: snippet, kind: "text" });
                }
              }
            }
          } catch {}
        }
        return json(activities.slice(-100));
      } catch {
        return json([]);
      }
    }

    // POST /api/tasks/:id/retry — reset a failed/stuck task and re-dispatch, preserving worktree
    const retryMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/retry$/);
    if (retryMatch && req.method === "POST") {
      const taskId = retryMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      if (task.status === "active") {
        // Kill the active worker first
        const { stopWorker } = await import("../agents/worker");
        stopWorker(taskId, db);
      }
      // Increment retry count, reset status to queued, preserve worktree/branch/artifacts
      db.run(
        "UPDATE tasks SET status = 'queued', retry_count = retry_count + 1, paused = 0 WHERE id = ?",
        [taskId]
      );
      db.addEvent(taskId, null, "task_retried", `Task retried (attempt ${(task.retry_count ?? 0) + 2})`);
      const { enqueue } = await import("./dispatch");
      enqueue(taskId);
      return json({ ok: true, taskId, status: "queued" });
    }

    // POST /api/tasks/:id/resume — resume a task at its current step or a specific step
    const resumeMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/resume$/);
    if (resumeMatch && req.method === "POST") {
      const taskId = resumeMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);

      // Parse optional step from request body
      let step: string | undefined;
      try {
        const body = await req.json();
        if (body.step) step = body.step;
      } catch {}

      // Only allow resume on failed, paused, or queued tasks
      if (task.status === "completed") {
        return json({ error: "Cannot resume a completed task" }, 400);
      }
      if (task.status === "active" && !task.paused) {
        // Kill active worker before resuming at a different step
        const { stopWorker } = await import("../agents/worker");
        stopWorker(taskId, db);
      }

      // If a step is specified, update current_step before enqueue
      if (step) {
        const { configNormalizedPaths } = await import("./config");
        const paths = configNormalizedPaths();
        const pathConfig = paths[task.path_name];
        if (!pathConfig) return json({ error: `Path "${task.path_name}" not found` }, 400);
        const targetStep = pathConfig.steps.find((s: any) => s.id === step);
        if (!targetStep) return json({ error: `Step "${step}" not found in path "${task.path_name}"` }, 400);
        const stepIndex = pathConfig.steps.indexOf(targetStep);
        db.run("UPDATE tasks SET current_step = ?, step_index = ? WHERE id = ?", [step, stepIndex, taskId]);
      }

      db.run("UPDATE tasks SET status = 'queued', retry_count = 0, paused = 0 WHERE id = ?", [taskId]);
      db.addEvent(taskId, null, "task_resume_requested", `Resume requested at step "${step ?? task.current_step ?? "current"}"`);
      const { enqueue } = await import("./dispatch");
      enqueue(taskId);
      return json({ ok: true, taskId, step: step ?? task.current_step, status: "queued" });
    }

    // POST /api/tasks/:id/verdict — maintainer decision on PR review
    const verdictMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/verdict$/);
    if (verdictMatch && req.method === "POST") {
      const taskId = verdictMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      if (task.status !== "waiting") return json({ error: "Task is not awaiting verdict" }, 400);
      if (!task.source_pr || !task.tree_id) return json({ error: "Task has no source PR" }, 400);

      const tree = db.treeGet(task.tree_id);
      if (!tree?.github) return json({ error: "Tree has no GitHub repo" }, 400);

      let body: { action: string; comment?: string };
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      const { action, comment } = body;

      switch (action) {
        case "merge": {
          const { ghPrMerge } = await import("../shared/github");
          const merged = ghPrMerge(tree.github, task.source_pr);
          if (!merged) return json({ error: "Merge failed — PR may have conflicts" }, 500);
          db.run("UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now'), paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_merge", `Maintainer merged PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "completed" });
          return json({ ok: true, action: "merge" });
        }

        case "request_changes": {
          const { ghPrReview } = await import("../shared/github");
          const posted = ghPrReview(tree.github, task.source_pr, {
            event: "REQUEST_CHANGES",
            body: comment ?? "Changes requested.",
          });
          db.run("UPDATE tasks SET status = 'deferred', paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_request_changes", `Maintainer requested changes on PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "deferred" });
          return json({ ok: true, action: "request_changes", posted });
        }

        case "close": {
          const { ghPrClose } = await import("../shared/github");
          ghPrClose(tree.github, task.source_pr, comment);
          db.run("UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now'), paused = 0 WHERE id = ?", [taskId]);
          db.addEvent(taskId, null, "verdict_close", `Maintainer closed PR #${task.source_pr}`);
          bus.emit("task:status", { taskId, status: "completed" });
          return json({ ok: true, action: "close" });
        }

        case "defer": {
          db.addEvent(taskId, null, "verdict_defer", "Maintainer deferred decision");
          return json({ ok: true, action: "defer" });
        }

        default:
          return json({ error: `Unknown action: ${action}` }, 400);
      }
    }

    // POST /api/rotate-credentials — regenerate auth token + subdomain + secret
    if (path === "/api/rotate-credentials" && req.method === "POST") {
      const { rotateToken } = await import("./auth");
      const { configSet, tunnelConfig: getTunnelConfig, reloadConfig } = await import("./config");
      const { generateSubdomain, generateSecret } = await import("./subdomain");
      const { deregisterGrove } = await import("./registry");

      // Rotate the auth token
      const newToken = rotateToken();

      const tc = getTunnelConfig();
      let newSubdomain: string | null = null;

      // Deregister old subdomain from Worker, generate new ones
      if (tc.domain && tc.subdomain && tc.secret) {
        try {
          await deregisterGrove({
            registryUrl: `https://${tc.domain}`,
            subdomain: tc.subdomain,
            secret: tc.secret,
          });
        } catch {}

        newSubdomain = generateSubdomain();
        const newSecret = generateSecret();
        configSet("tunnel.subdomain", newSubdomain);
        configSet("tunnel.secret", newSecret);
        reloadConfig();
      }

      db.addEvent(null, null, "credentials_rotated", "Auth token and tunnel credentials rotated via GUI");

      return json({
        ok: true,
        message: "Credentials rotated. Grove will restart to apply new tunnel URL.",
        token: newToken,
        subdomain: newSubdomain,
      });
    }

    // POST /api/restart — restart the broker process
    if (path === "/api/restart" && req.method === "POST") {
      db.addEvent(null, null, "broker_restart", "Restart requested via GUI");
      // Use a shell script that outlives this process: down, sleep, up
      const grove = process.execPath;
      const script = `"${grove}" down; sleep 2; "${grove}" up`;
      setTimeout(() => {
        Bun.spawn(["bash", "-c", `nohup bash -c '${script}' &>/dev/null &`], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        // Give the shell a moment to fork, then exit
        setTimeout(() => process.exit(0), 200);
      }, 300);
      return json({ ok: true, message: "Restarting..." });
    }

    // GET /api/analytics/cost?range=1h|4h|24h|7d
    if (path === "/api/analytics/cost" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        by_tree: db.costByTree(since),
        daily: db.costDaily(since),
        top_tasks: db.costTopTasks(since, 10),
      });
    }

    // GET /api/analytics/gates?range=1h|4h|24h|7d
    if (path === "/api/analytics/gates" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        gates: db.gateAnalytics(since),
        retries: db.retryStats(since),
      });
    }

    // GET /api/analytics/timeline?range=1h|4h|24h|7d
    if (path === "/api/analytics/timeline" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "24h");
      return json({
        tasks: db.taskTimeline(since),
      });
    }

    // GET /api/analytics/utilization?range=1h|4h|24h|7d — worker utilization
    if (path === "/api/analytics/utilization" && req.method === "GET") {
      const range = new URL(req.url).searchParams.get("range") ?? "24h";
      return json(db.workerUtilization(range));
    }

    // GET /api/analytics/insights?range=1h|4h|24h|7d — cross-task pattern insights
    if (path === "/api/analytics/insights" && req.method === "GET") {
      const url = new URL(req.url);
      const since = rangeToSince(url.searchParams.get("range") ?? "7d");
      return json({
        failing_gates: db.insightsFailingGates(since),
        retries_by_path: db.insightsRetriesByPath(since),
        tree_failure_rates: db.insightsTreeFailureRates(since),
        success_trend: db.insightsSuccessTrend(since),
        common_failures: db.insightsCommonFailures(since),
      });
    }

    // GET /api/analytics/events — filtered event log
    if (path === "/api/analytics/events" && req.method === "GET") {
      const params = new URL(req.url).searchParams;
      return json(db.filteredEvents({
        taskId: params.get("task") ?? undefined,
        eventType: params.get("type") ?? undefined,
        since: params.get("since") ?? "24h",
        limit: Number(params.get("limit") ?? 200),
      }));
    }

    // POST /api/orchestrator/reset — start a fresh orchestrator session
    if (path === "/api/orchestrator/reset" && req.method === "POST") {
      const { resetSession } = await import("../agents/orchestrator");
      resetSession();
      db.addEvent(null, null, "orchestrator_rotated", "Orchestrator session reset by user");
      return json({ ok: true, message: "Orchestrator session reset. Next message starts a fresh session." });
    }

    // GET /api/events
    if (path === "/api/events" && req.method === "GET") {
      const url = new URL(req.url);
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const taskId = url.searchParams.get("task");
      return json(taskId ? db.eventsByTask(taskId) : db.recentEvents(limit));
    }

    // GET /api/messages
    if (path === "/api/messages" && req.method === "GET") {
      const url = new URL(req.url);
      const channel = url.searchParams.get("channel") ?? "main";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      return json(db.recentMessages(channel, limit));
    }

    // GET /api/tasks/:id/seed — get seed for a task
    const seedGetMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/seed$/);
    if (seedGetMatch && req.method === "GET") {
      const seed = db.seedGet(seedGetMatch[1]);
      if (!seed) return json(null);
      // Map internal role field to frontend source field
      const conv = seed.conversation ? JSON.parse(seed.conversation) : [];
      return json({
        ...seed,
        active: isSeedSessionActive(seedGetMatch[1]),
        conversation: conv.map((m: any) => ({
          source: m.source ?? (m.role === "assistant" ? "ai" : "user"),
          content: m.content,
          ...(m.html ? { html: m.html } : {}),
        })),
      });
    }

    // POST /api/tasks/:id/seed/start — start a seed session
    const seedStartMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/seed\/start$/);
    if (seedStartMatch && req.method === "POST") {
      const taskId = seedStartMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      if (!task.tree_id) return json({ error: "Task has no tree" }, 400);
      const tree = db.treeGet(task.tree_id);
      if (!tree) return json({ error: "Tree not found" }, 404);
      const { getEnv } = await import("./db");
      startSeedSession(task, tree, db, getEnv().GROVE_LOG_DIR);
      return json({ ok: true, taskId });
    }

    // POST /api/tasks/:id/seed/stop — stop a seed session
    const seedStopMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/seed\/stop$/);
    if (seedStopMatch && req.method === "POST") {
      stopSeedSession(seedStopMatch[1], db);
      return json({ ok: true });
    }

    // DELETE /api/tasks/:id/seed — discard a seed (for re-seed)
    const seedDeleteMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/seed$/);
    if (seedDeleteMatch && req.method === "DELETE") {
      stopSeedSession(seedDeleteMatch[1], db);
      db.seedDiscard(seedDeleteMatch[1]);
      return json({ ok: true });
    }

    // POST /api/batch/analyze — analyze draft tasks for a tree and produce a batch plan
    if (path === "/api/batch/analyze" && req.method === "POST") {
      const body = await req.json() as { treeId: string; mode?: "heuristic" | "agent" | "hybrid" };
      if (!body.treeId) return json({ error: "treeId required" }, 400);

      const tree = db.treeGet(body.treeId);
      if (!tree) return json({ error: `Tree "${body.treeId}" not found` }, 404);

      const drafts = db.all<any>(
        "SELECT * FROM tasks WHERE tree_id = ? AND status = 'draft' ORDER BY priority ASC, created_at ASC",
        [body.treeId]
      );

      if (drafts.length === 0) {
        return json({ treeId: body.treeId, tasks: [], overlaps: [], waves: [] });
      }

      const { analyzeBatch } = await import("../batch/analyze");
      const plan = await analyzeBatch(drafts, tree.path, body.mode);
      return json(plan);
    }

    // POST /api/batch/dispatch — set dependencies and dispatch a wave from a batch plan
    if (path === "/api/batch/dispatch" && req.method === "POST") {
      const body = await req.json() as { treeId: string; wave: number };
      if (!body.treeId) return json({ error: "treeId required" }, 400);
      if (!body.wave || body.wave < 1) return json({ error: "wave must be a positive integer" }, 400);

      const tree = db.treeGet(body.treeId);
      if (!tree) return json({ error: `Tree "${body.treeId}" not found` }, 404);

      // Re-analyze to get fresh plan
      const drafts = db.all<any>(
        "SELECT * FROM tasks WHERE tree_id = ? AND status = 'draft' ORDER BY priority ASC, created_at ASC",
        [body.treeId]
      );

      if (drafts.length === 0) {
        return json({ error: "No draft tasks to dispatch" }, 400);
      }

      const { analyzeBatch, computeDependsOn } = await import("../batch/analyze");
      const plan = await analyzeBatch(drafts, tree.path);

      const targetWave = plan.waves.find(w => w.wave === body.wave);
      if (!targetWave) {
        return json({ error: `Wave ${body.wave} not found in plan` }, 400);
      }

      // Set depends_on for tasks in later waves
      const deps = computeDependsOn(plan.waves);
      const dependsOnSet: Record<string, string> = {};
      for (const [taskId, depStr] of deps) {
        db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [depStr, taskId]);
        dependsOnSet[taskId] = depStr;
      }

      // Dispatch tasks in the target wave
      const dispatched: string[] = [];
      const { enqueue } = await import("./dispatch");
      for (const taskId of targetWave.taskIds) {
        db.taskSetStatus(taskId, "queued");
        enqueue(taskId);
        dispatched.push(taskId);
      }

      db.addEvent(null, null, "batch_dispatched",
        `Batch wave ${body.wave}: dispatched ${dispatched.join(", ")} for tree ${body.treeId}`);

      return json({ ok: true, dispatched, dependsOnSet, wave: body.wave });
    }

    // GET /api/plugins — list loaded plugins
    if (path === "/api/plugins" && req.method === "GET") {
      const { getPluginHost } = await import("./index");
      const host = getPluginHost();
      return json(host ? host.list() : []);
    }

    // POST /api/plugins/:name/enable
    const enableMatch = path.match(/^\/api\/plugins\/([^/]+)\/enable$/);
    if (enableMatch && req.method === "POST") {
      const { getPluginHost } = await import("./index");
      const host = getPluginHost();
      if (!host) return json({ error: "Plugin system not initialized" }, 500);
      const ok = host.enable(decodeURIComponent(enableMatch[1]));
      return ok ? json({ ok: true }) : json({ error: "Plugin not found" }, 404);
    }

    // POST /api/plugins/:name/disable
    const disableMatch = path.match(/^\/api\/plugins\/([^/]+)\/disable$/);
    if (disableMatch && req.method === "POST") {
      const { getPluginHost } = await import("./index");
      const host = getPluginHost();
      if (!host) return json({ error: "Plugin system not initialized" }, 500);
      const ok = host.disable(decodeURIComponent(disableMatch[1]));
      return ok ? json({ ok: true }) : json({ error: "Plugin not found" }, 404);
    }

    // GET /api/adapters — list available adapters
    if (path === "/api/adapters" && req.method === "GET") {
      const { getAdapterRegistry } = await import("./index");
      const registry = getAdapterRegistry();
      const adapters = registry?.listAll().map(a => ({
        name: a.name,
        available: a.isAvailable(),
        supportsResume: a.supportsResume,
      })) ?? [];
      return json(adapters);
    }

    // ---- DAG endpoints ----

    // GET /api/tasks/dag — full DAG (nodes + edges)
    if (path === "/api/tasks/dag" && req.method === "GET") {
      const tasks = db.all<{ id: string; title: string; status: string }>(
        "SELECT id, title, status FROM tasks ORDER BY created_at DESC",
      );
      const edges = db.allTaskEdges();
      return json({ nodes: tasks, edges });
    }

    // POST /api/tasks/edges — add dependency edge
    if (path === "/api/tasks/edges" && req.method === "POST") {
      const body = await req.json() as any;
      const { from, to, type } = body;
      if (!from || !to) return json({ error: "Missing from or to" }, 400);

      // Check for cycle before adding
      const existingEdges: DagEdge[] = db.allTaskEdges().map(e => ({ from: e.from_task, to: e.to_task }));
      existingEdges.push({ from, to });
      const allIds = new Set([...existingEdges.map(e => e.from), ...existingEdges.map(e => e.to)]);
      const cycle = detectCycle([...allIds], existingEdges);
      if (cycle) return json({ error: "Would create a cycle", cycle }, 400);

      db.addEdge(from, to, type ?? "dependency");
      return json({ ok: true });
    }

    // DELETE /api/tasks/edges/:from/:to — remove dependency edge
    const edgeDeleteMatch = path.match(/^\/api\/tasks\/edges\/([^/]+)\/([^/]+)$/);
    if (edgeDeleteMatch && req.method === "DELETE") {
      db.removeEdge(edgeDeleteMatch[1], edgeDeleteMatch[2]);
      return json({ ok: true });
    }

    // POST /api/tasks/dag/validate — check for cycles
    if (path === "/api/tasks/dag/validate" && req.method === "POST") {
      const edges: DagEdge[] = db.allTaskEdges().map(e => ({ from: e.from_task, to: e.to_task }));
      const allIds = new Set([...edges.map(e => e.from), ...edges.map(e => e.to)]);
      const cycle = detectCycle([...allIds], edges);
      return json({ valid: !cycle, cycle });
    }

    // ---- Skill management endpoints ----

    // GET /api/skills — list installed skills
    if (path === "/api/skills" && req.method === "GET") {
      const { loadSkills } = await import("../skills/library");
      return json(loadSkills().map(s => s.manifest));
    }

    // GET /api/skills/:name — single skill detail + file contents
    const skillDetailMatch = path.match(/^\/api\/skills\/([^/]+)$/);
    if (skillDetailMatch && req.method === "GET") {
      const { getSkill } = await import("../skills/library");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const name = decodeURIComponent(skillDetailMatch[1]);
      const skill = getSkill(name);
      if (!skill) return json({ error: "Skill not found" }, 404);

      const files: Record<string, string> = {};
      for (const filename of skill.manifest.files) {
        try {
          files[filename] = readFileSync(join(skill.dir, filename), "utf-8");
        } catch {
          files[filename] = "";
        }
      }

      return json({ ...skill.manifest, files_content: files });
    }

    // POST /api/skills/install — install from path or git URL
    if (path === "/api/skills/install" && req.method === "POST") {
      const body = await req.json() as { source?: string };
      if (!body.source) return json({ error: "source required" }, 400);

      const { installSkillFromPath, installSkillFromGit } = await import("../skills/library");
      const source = body.source;
      const isGit = source.startsWith("http") || source.startsWith("git@") || source.endsWith(".git");

      const result = isGit
        ? await installSkillFromGit(source)
        : installSkillFromPath(source);

      if (!result.ok) return json({ error: result.error }, 400);

      bus.emit("skill:installed", { name: result.name! });
      return json({ ok: true, name: result.name }, 201);
    }

    // DELETE /api/skills/:name — remove installed skill
    if (skillDetailMatch && req.method === "DELETE") {
      const { removeSkill } = await import("../skills/library");
      const name = decodeURIComponent(skillDetailMatch[1]);
      const removed = removeSkill(name);
      if (!removed) return json({ error: "Skill not found" }, 404);

      bus.emit("skill:removed", { name });
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Check if a request is coming from a remote origin (not localhost) */
function isRemoteRequest(req: Request): boolean {
  const host = req.headers.get("host") || "";
  return !host.startsWith("localhost") && !host.startsWith("127.0.0.1") && !host.startsWith("[::1]");
}

/** Validate auth token from Authorization header or ?token= query param */
function isAuthorized(req: Request): boolean {
  const { validateToken } = require("./auth");

  // Check Authorization: Bearer <token>
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return validateToken(authHeader.slice(7));
  }

  // Check ?token= query parameter
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam) {
    return validateToken(tokenParam);
  }

  return false;
}

/** Convert a range string (1h, 4h, 24h, 7d) to an ISO since timestamp */
function rangeToSince(range: string): string {
  const ms: Record<string, number> = {
    "1h": 3600000,
    "4h": 14400000,
    "24h": 86400000,
    "7d": 604800000,
  };
  const offset = ms[range] ?? ms["24h"];
  return new Date(Date.now() - offset).toISOString();
}
