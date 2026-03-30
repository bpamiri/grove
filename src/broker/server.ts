// Grove v3 — Bun HTTP + WebSocket server with REST API and static file serving
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Database } from "./db";
import { bus } from "./event-bus";
import { GROVE_VERSION, type EventBusMap } from "../shared/types";
import { EMBEDDED_ASSETS } from "./web-assets.generated";
import { startSeedSession, sendSeedMessage, stopSeedSession, isSeedSessionActive, setSeedBroadcast } from "./seed-session";

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

/** Set the tunnel URL (called after tunnel starts) */
export function setRemoteUrl(url: string | null): void {
  _remoteUrl = url;
}

// Broadcast a message to all connected WebSocket clients
function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

// Subscribe to event bus and broadcast to WS clients
function wireEventBus() {
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

  wireEventBus();
  setSeedBroadcast(broadcast);

  server = Bun.serve<WSData>({
    port,

    fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    // GET /api/trees
    if (path === "/api/trees" && req.method === "GET") {
      return json(db.allTrees());
    }

    // POST /api/trees
    if (path === "/api/trees" && req.method === "POST") {
      const body = await req.json() as { id?: string; path: string; github?: string; branch_prefix?: string };
      if (!body.path) return json({ error: "path required" }, 400);
      const { basename } = await import("node:path");
      const id = body.id ?? basename(body.path).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      db.treeUpsert({
        id,
        name: id,
        path: body.path,
        github: body.github,
        branch_prefix: body.branch_prefix ?? "grove/",
      });
      return json(db.treeGet(id), 201);
    }

    // GET /api/trees/:id/issues — fetch open GitHub issues for a tree
    const issuesMatch = path.match(/^\/api\/trees\/([^/]+)\/issues$/);
    if (issuesMatch && req.method === "GET") {
      const tree = db.treeGet(issuesMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json([]);
      try {
        const { ghIssueList } = await import("../merge/github");
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

    // POST /api/trees/:id/import-issues — create tasks from open GitHub issues
    const importMatch = path.match(/^\/api\/trees\/([^/]+)\/import-issues$/);
    if (importMatch && req.method === "POST") {
      const tree = db.treeGet(importMatch[1]);
      if (!tree) return json({ error: "Tree not found" }, 404);
      if (!tree.github) return json({ error: "No GitHub repo configured" }, 400);

      try {
        const { ghIssueList } = await import("../merge/github");
        const issues = ghIssueList(tree.github, { state: "open", limit: 50 });

        // Find issues that already have tasks (by github_issue column)
        const existingIssueNums = new Set<number>(
          db.all<{ github_issue: number }>(
            "SELECT github_issue FROM tasks WHERE tree_id = ? AND github_issue IS NOT NULL",
            [tree.id]
          ).map(r => r.github_issue)
        );

        let imported = 0;
        for (const issue of issues) {
          if (existingIssueNums.has(issue.number)) continue;

          const taskId = db.nextTaskId("W");
          const title = `${issue.title} Issue #${issue.number}`;
          const description = issue.body || "";
          db.run(
            "INSERT INTO tasks (id, tree_id, title, description, path_name, status, github_issue) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
            [taskId, tree.id, title, description, "development", issue.number]
          );
          db.addEvent(taskId, null, "task_created", `Imported from ${tree.github}#${issue.number}`);
          imported++;
        }

        return json({ ok: true, imported, skipped: issues.length - imported, total: issues.length });
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
      const body = await req.json() as { title: string; tree_id?: string; description?: string; path_name?: string };
      const taskId = db.nextTaskId("W");
      db.run(
        "INSERT INTO tasks (id, tree_id, title, description, path_name, status) VALUES (?, ?, ?, ?, ?, 'draft')",
        [taskId, body.tree_id ?? null, body.title, body.description ?? null, body.path_name ?? "development"],
      );
      db.addEvent(taskId, null, "task_created", `Task created: ${body.title}`);
      const task = db.taskGet(taskId);
      bus.emit("task:created", { task: task! });
      return json(task, 201);
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

    // POST /api/tasks/:id/dispatch — promote to ready and enqueue
    const dispatchMatch = path.match(/^\/api\/tasks\/([A-Z]+-\d+)\/dispatch$/);
    if (dispatchMatch && req.method === "POST") {
      const taskId = dispatchMatch[1];
      const task = db.taskGet(taskId);
      if (!task) return json({ error: "Task not found" }, 404);
      const { configNormalizedPaths } = await import("./config");
      const paths = configNormalizedPaths();
      const pathConfig = paths[task.path_name];
      if (pathConfig && pathConfig.steps.length > 0) {
        db.run("UPDATE tasks SET current_step = ?, step_index = 0 WHERE id = ?",
          [pathConfig.steps[0].id, taskId]);
      }
      db.taskSetStatus(taskId, "queued");
      const { enqueue } = await import("./dispatch");
      enqueue(taskId);
      return json({ ok: true, taskId, status: "queued" });
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
      return json({
        ...seed,
        active: isSeedSessionActive(seedGetMatch[1]),
        conversation: seed.conversation ? JSON.parse(seed.conversation) : [],
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
