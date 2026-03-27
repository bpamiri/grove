// Grove v3 — Bun HTTP + WebSocket server with REST API and static file serving
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Database } from "./db";
import { bus } from "./event-bus";
import type { EventBusMap } from "../shared/types";

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

      // WebSocket upgrade
      if (path === "/ws") {
        const upgraded = server.upgrade(req, { data: { authenticated: false } });
        if (upgraded) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      if (path.startsWith("/api/")) {
        return handleApi(path, req, db, onChat, corsHeaders);
      }

      // Static file serving (React SPA)
      if (staticDir && existsSync(staticDir)) {
        return serveStatic(path, staticDir, corsHeaders);
      }

      // Fallback: JSON status
      return new Response(JSON.stringify({ name: "grove", version: "3.0.0-alpha.0", status: "running" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
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
        broker: "running",
        orchestrator: isRunning() ? "running" : "stopped",
        workers: activeWorkerCount(),
        queue: queueLength(),
        spawningPaused: isSpawningPaused(),
        wsClients: wsClients.size,
        tasks: {
          total: db.taskCount(),
          running: db.taskCount("running"),
          done: db.taskCount("done"),
          planned: db.taskCount("planned"),
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

    // GET /api/tasks
    if (path === "/api/tasks" && req.method === "GET") {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const tree = url.searchParams.get("tree");

      let tasks;
      if (tree) tasks = db.tasksByTree(tree);
      else if (status) tasks = db.tasksByStatus(status);
      else tasks = db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50");
      return json(tasks);
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
        "INSERT INTO tasks (id, tree_id, title, description, path_name) VALUES (?, ?, ?, ?, ?)",
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

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
