// grove dashboard — Live-refreshing TUI dashboard
import { getDb, getEnv } from "../core/db";
import { budgetGet, workspaceName } from "../core/config";
import * as ui from "../core/ui";
import type { Command, Task, Session, Event } from "../types";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const MAGENTA = `${ESC}[35m`;
const CYAN = `${ESC}[36m`;
const WHITE = `${ESC}[37m`;
const BG_RED = `${ESC}[41m`;
const BG_GREEN = `${ESC}[42m`;
const BG_YELLOW = `${ESC}[43m`;
const BG_BLUE = `${ESC}[44m`;

// Box-drawing characters
const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  tee_r: "├", tee_l: "┤",
  cross: "┼",
  h_down: "┬", h_up: "┴",
};

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function box(title: string, lines: string[], width: number, titleColor: string = WHITE): string {
  const inner = width - 2;
  const out: string[] = [];

  // Top border with title
  const titleStr = ` ${title} `;
  const titleLen = title.length + 2;
  const leftPad = 2;
  const rightPad = Math.max(0, inner - leftPad - titleLen);
  out.push(
    `${DIM}${BOX.tl}${BOX.h.repeat(leftPad)}${RESET}${BOLD}${titleColor}${titleStr}${RESET}${DIM}${BOX.h.repeat(rightPad)}${BOX.tr}${RESET}`
  );

  // Content lines
  for (const line of lines) {
    const visible = stripAnsi(line);
    const pad = Math.max(0, inner - visible);
    out.push(`${DIM}${BOX.v}${RESET}${line}${" ".repeat(pad)}${DIM}${BOX.v}${RESET}`);
  }

  // Bottom border
  out.push(`${DIM}${BOX.bl}${BOX.h.repeat(inner)}${BOX.br}${RESET}`);

  return out.join("\n");
}

function statusIcon(status: string): string {
  switch (status) {
    case "running": return `${GREEN}●${RESET}`;
    case "paused": return `${YELLOW}◉${RESET}`;
    case "ready": return `${BLUE}○${RESET}`;
    case "ingested": return `${DIM}◌${RESET}`;
    case "planned": return `${CYAN}◌${RESET}`;
    case "done":
    case "completed": return `${GREEN}✓${RESET}`;
    case "failed": return `${RED}✗${RESET}`;
    case "review": return `${MAGENTA}◎${RESET}`;
    default: return `${DIM}·${RESET}`;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return `${GREEN}running${RESET}`;
    case "paused": return `${YELLOW}paused${RESET}`;
    case "ready": return `${BLUE}ready${RESET}`;
    case "done":
    case "completed": return `${GREEN}done${RESET}`;
    case "failed": return `${RED}failed${RESET}`;
    case "review": return `${MAGENTA}review${RESET}`;
    default: return `${DIM}${status}${RESET}`;
  }
}

function elapsedTime(startedAt: string): string {
  const normalized =
    startedAt.replace(" ", "T").replace(/Z$/, "") +
    (startedAt.includes("Z") || startedAt.includes("+") ? "" : "Z");
  const dt = new Date(normalized);
  if (isNaN(dt.getTime())) return "-";

  const totalSecs = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (totalSecs < 0) return "0s";
  if (totalSecs < 60) return `${totalSecs}s`;
  if (totalSecs < 3600) {
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}m ${s}s`;
  }
  if (totalSecs < 86400) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  return `${d}d ${h}h`;
}

function budgetBar(current: number, max: number, width: number = 20): string {
  if (max <= 0) return `${DIM}no limit${RESET}`;
  const pct = Math.min(current / max, 1.0);
  const filled = Math.round(pct * width);
  const empty = width - filled;

  let color: string;
  if (pct >= 0.9) color = RED;
  else if (pct >= 0.7) color = YELLOW;
  else color = GREEN;

  const filledStr = "█".repeat(filled);
  const emptyStr = `${DIM}░${RESET}`.repeat(empty);
  // Since emptyStr has ANSI codes per character, build differently
  const emptyPlain = "░".repeat(empty);
  return `${color}${filledStr}${RESET}${DIM}${emptyPlain}${RESET} ${color}${Math.round(pct * 100)}%${RESET}`;
}

function timeStr(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Draw the full dashboard
// ---------------------------------------------------------------------------

function draw(): void {
  const db = getDb();
  const cols = Math.min(process.stdout.columns || 80, 100);
  const halfWidth = Math.floor(cols / 2);
  const w = cols;

  const buf: string[] = [];

  // ── Header ──
  buf.push(CLEAR + HIDE_CURSOR);
  buf.push("");

  const wsName = (() => { try { return workspaceName(); } catch { return "Grove"; } })();
  buf.push(` ${GREEN}${BOLD}🌿 ${wsName}${RESET}  ${DIM}dashboard  ${timeStr()}  refresh: 5s${RESET}`);
  buf.push("");

  // ── Active Workers ──
  const running = db.all<Task>(
    "SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC",
  );
  const paused = db.all<Task>(
    "SELECT * FROM tasks WHERE status = 'paused' ORDER BY paused_at DESC",
  );

  const workerLines: string[] = [];
  if (running.length === 0 && paused.length === 0) {
    workerLines.push(`  ${DIM}No active workers. Run ${RESET}${BOLD}grove work${RESET}${DIM} to start.${RESET}`);
  } else {
    // Column headers
    workerLines.push(
      `  ${DIM}${"TASK".padEnd(10)}${"REPO".padEnd(12)}${"STATUS".padEnd(10)}${"ELAPSED".padEnd(12)}ACTIVITY${RESET}`
    );

    for (const t of running) {
      const elapsed = t.started_at ? elapsedTime(t.started_at) : "-";
      const lastEvt = db.get<{ summary: string }>(
        "SELECT summary FROM events WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1",
        [t.id],
      );
      const activity = lastEvt?.summary ?? t.session_summary ?? "";
      workerLines.push(
        `  ${BOLD}${t.id.padEnd(10)}${RESET}${(t.repo ?? "-").padEnd(12)}${statusIcon(t.status)} ${statusLabel(t.status).padEnd(10 + 9)}${GREEN}${elapsed.padEnd(12)}${RESET}${DIM}${truncStr(activity, 30)}${RESET}`
      );
    }

    for (const t of paused) {
      const elapsed = t.paused_at ? elapsedTime(t.paused_at) + " ago" : "-";
      workerLines.push(
        `  ${BOLD}${t.id.padEnd(10)}${RESET}${(t.repo ?? "-").padEnd(12)}${statusIcon(t.status)} ${statusLabel(t.status).padEnd(10 + 9)}${YELLOW}${elapsed.padEnd(12)}${RESET}${DIM}${truncStr(t.next_steps ?? "", 30)}${RESET}`
      );
    }
  }
  buf.push(box("WORKERS", workerLines, w, YELLOW));
  buf.push("");

  // ── Budget + Queue side by side ──
  // Budget section
  let todayCost = 0, weekCost = 0, dailyLimit = 25, weeklyLimit = 100;
  try { todayCost = db.costToday(); } catch {}
  try { weekCost = db.costWeek(); } catch {}
  try { dailyLimit = budgetGet("per_day") || 25; } catch {}
  try { weeklyLimit = budgetGet("per_week") || 100; } catch {}

  const totalSpent = db.scalar<number>(
    "SELECT COALESCE(SUM(cost_usd), 0) FROM sessions"
  ) ?? 0;
  const activeSessions = db.scalar<number>(
    "SELECT COUNT(*) FROM sessions WHERE status = 'running'"
  ) ?? 0;

  const budgetLines: string[] = [];
  budgetLines.push(`  ${DIM}Today${RESET}   ${ui.dollars(todayCost).padEnd(10)} ${budgetBar(todayCost, dailyLimit, 14)}`);
  budgetLines.push(`  ${DIM}Week${RESET}    ${ui.dollars(weekCost).padEnd(10)} ${budgetBar(weekCost, weeklyLimit, 14)}`);
  budgetLines.push(`  ${DIM}All-time${RESET} ${ui.dollars(totalSpent)}`);
  buf.push(box("BUDGET", budgetLines, w, BLUE));
  buf.push("");

  // ── Tasks ──
  const allTasks = db.all<Task>(
    `SELECT * FROM tasks
     WHERE status NOT IN ('completed', 'done', 'failed')
     ORDER BY
       CASE status
         WHEN 'ready' THEN 0
         WHEN 'planned' THEN 1
         WHEN 'ingested' THEN 2
         WHEN 'review' THEN 3
         ELSE 4
       END,
       priority ASC, created_at ASC
     LIMIT 12`,
  );

  const taskLines: string[] = [];

  if (allTasks.length === 0) {
    taskLines.push(`  ${DIM}No tasks. Run ${RESET}${BOLD}grove add${RESET}${DIM} or ${RESET}${BOLD}grove sync${RESET}${DIM} to bring in work.${RESET}`);
  } else {
    // Column headers
    taskLines.push(
      `  ${DIM}${"ID".padEnd(10)}${"REPO".padEnd(12)}${"STATUS".padEnd(12)}${"TITLE"}${RESET}`
    );

    for (const t of allTasks) {
      // Skip running/paused — already shown in WORKERS
      if (t.status === "running" || t.status === "paused") continue;

      const strat = t.strategy ? `${DIM} [${t.strategy}]${RESET}` : "";
      const cost = t.estimated_cost && t.estimated_cost > 0 ? `${DIM} ~${ui.dollars(t.estimated_cost)}${RESET}` : "";
      const titleWidth = Math.max(20, w - 38);

      taskLines.push(
        `  ${statusIcon(t.status)} ${BOLD}${t.id.padEnd(9)}${RESET}${(t.repo ?? "-").padEnd(12)}${statusLabel(t.status).padEnd(12 + 9)}${truncStr(t.title, titleWidth)}${strat}${cost}`
      );

      // Show description snippet if different from title
      if (t.description && t.description !== t.title) {
        taskLines.push(
          `    ${DIM}${truncStr(t.description, titleWidth + 20)}${RESET}`
        );
      }
    }

    // Counts of what's not shown
    const totalQueued = db.scalar<number>(
      "SELECT COUNT(*) FROM tasks WHERE status NOT IN ('completed', 'done', 'failed', 'running', 'paused')"
    ) ?? 0;
    const shown = taskLines.length - 1; // minus header
    if (totalQueued > shown) {
      taskLines.push(`  ${DIM}… and ${totalQueued - shown} more (grove tasks --all)${RESET}`);
    }
  }

  buf.push(box("TASKS", taskLines, w, CYAN));
  buf.push("");

  // ── Recent Events ──
  const events = db.recentEvents(8);
  const eventLines: string[] = [];

  if (events.length === 0) {
    eventLines.push(`  ${DIM}No events yet${RESET}`);
  } else {
    for (const e of events) {
      const rel = ui.relativeTime(e.timestamp);
      const taskTag = e.task_id ? `${BLUE}${e.task_id.padEnd(8)}${RESET}` : `${"".padEnd(8)}`;
      const typeIcon = eventIcon(e.event_type);
      eventLines.push(
        `  ${DIM}${rel.padEnd(14)}${RESET} ${typeIcon} ${taskTag} ${truncStr(e.summary ?? "", 42)}`
      );
    }
  }
  buf.push(box("EVENTS", eventLines, w, GREEN));
  buf.push("");

  // ── Keyboard shortcuts ──
  buf.push(
    ` ${DIM}${BOX.h.repeat(w - 2)}${RESET}`
  );
  buf.push(
    ` ${BOLD}q${RESET}${DIM} quit${RESET}  ${BOLD}w${RESET}${DIM} watch task${RESET}  ${BOLD}s${RESET}${DIM} start task${RESET}  ${BOLD}p${RESET}${DIM} pause task${RESET}  ${BOLD}r${RESET}${DIM} resume task${RESET}  ${BOLD}m${RESET}${DIM} message${RESET}`
  );

  process.stdout.write(buf.join("\n") + "\n");
}

function eventIcon(type: string): string {
  switch (type) {
    case "created": return `${BLUE}+${RESET}`;
    case "started":
    case "worker_spawned": return `${GREEN}▶${RESET}`;
    case "paused": return `${YELLOW}⏸${RESET}`;
    case "resumed": return `${GREEN}▶${RESET}`;
    case "completed":
    case "done": return `${GREEN}✓${RESET}`;
    case "failed": return `${RED}✗${RESET}`;
    case "pr_created": return `${MAGENTA}⎇${RESET}`;
    case "status_change": return `${CYAN}↻${RESET}`;
    case "planned": return `${BLUE}◆${RESET}`;
    case "auto_approved": return `${GREEN}✓${RESET}`;
    case "synced": return `${CYAN}⇣${RESET}`;
    case "message_sent": return `${YELLOW}✉${RESET}`;
    case "cancelled": return `${RED}⊘${RESET}`;
    default: return `${DIM}·${RESET}`;
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt helpers
// ---------------------------------------------------------------------------

function readLinePrompt(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(prompt);

    const onData = (chunk: Buffer) => {
      process.stdin.removeListener("data", onData);
      const line = chunk.toString().trim();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      resolve(line);
    };
    process.stdin.once("data", onData);
  });
}

function resumeRefresh(draw: () => void): NodeJS.Timer {
  draw();
  return setInterval(() => draw(), 5000);
}

// ---------------------------------------------------------------------------
// Dashboard command
// ---------------------------------------------------------------------------

export const dashboardCommand: Command = {
  name: "dashboard",
  description: "Live-refreshing TUI dashboard",

  async run() {
    const db = getDb();

    // Initial draw
    draw();

    // Set up refresh interval
    let refreshInterval: NodeJS.Timer = setInterval(() => draw(), 5000);

    // Set up raw mode for keyboard input
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    const cleanup = () => {
      clearInterval(refreshInterval);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(SHOW_CURSOR + "\n");
    };

    const sigHandler = () => { cleanup(); process.exit(0); };
    process.on("SIGINT", sigHandler);
    process.on("SIGTERM", sigHandler);

    await new Promise<void>((resolve) => {
      process.stdin.on("data", async (key: string) => {
        const ch = key.toLowerCase();

        if (ch === "q" || ch === "\x03") {
          cleanup();
          process.removeListener("SIGINT", sigHandler);
          process.removeListener("SIGTERM", sigHandler);
          resolve();
          return;
        }

        if (ch === "w") {
          clearInterval(refreshInterval);
          const tid = await readLinePrompt(`\n  ${BOLD}Task ID to watch:${RESET} `);
          if (tid) {
            cleanup();
            process.removeListener("SIGINT", sigHandler);
            process.removeListener("SIGTERM", sigHandler);
            resolve();
            const { watchCommand } = await import("./watch");
            await watchCommand.run([tid]);
            return;
          }
          refreshInterval = resumeRefresh(draw);
        }

        if (ch === "s") {
          clearInterval(refreshInterval);
          const tid = await readLinePrompt(`\n  ${BOLD}Task ID to start:${RESET} `);
          if (tid) {
            cleanup();
            process.removeListener("SIGINT", sigHandler);
            process.removeListener("SIGTERM", sigHandler);
            resolve();
            const { workCommand } = await import("./work");
            await workCommand.run([tid]);
            return;
          }
          refreshInterval = resumeRefresh(draw);
        }

        if (ch === "r") {
          clearInterval(refreshInterval);
          const tid = await readLinePrompt(`\n  ${BOLD}Task ID to resume:${RESET} `);
          if (tid) {
            cleanup();
            process.removeListener("SIGINT", sigHandler);
            process.removeListener("SIGTERM", sigHandler);
            resolve();
            const { resumeCommand } = await import("./resume");
            await resumeCommand.run([tid]);
            return;
          }
          refreshInterval = resumeRefresh(draw);
        }

        if (ch === "p") {
          clearInterval(refreshInterval);
          const tid = await readLinePrompt(`\n  ${BOLD}Task ID to pause:${RESET} `);
          if (tid) {
            const task = db.taskGet(tid);
            if (task && task.status === "running") {
              db.taskSetStatus(tid, "paused");
              ui.success(`Paused ${tid}`);
            } else if (task) {
              ui.warn(`Task ${tid} is not running (status: ${task.status})`);
            } else {
              ui.warn(`Task ${tid} not found`);
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
          refreshInterval = resumeRefresh(draw);
        }

        if (ch === "m") {
          clearInterval(refreshInterval);
          const tid = await readLinePrompt(`\n  ${BOLD}Task ID:${RESET} `);
          if (tid) {
            const msg = await readLinePrompt(`  ${BOLD}Message:${RESET} `);
            if (msg) {
              try {
                const { msgCommand } = await import("./msg");
                await msgCommand.run([tid, msg]);
              } catch (e: any) {
                ui.error(e.message || String(e));
              }
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          refreshInterval = resumeRefresh(draw);
        }
      });
    });
  },

  help() {
    return `Usage: grove dashboard

Live-refreshing TUI dashboard with box-drawn panels.

Displays:
  - Active workers with elapsed time, status, and last activity
  - Budget progress bars (today, week, all-time)
  - Queue of ready tasks with strategy and cost estimates
  - Recent events timeline with type icons

Keyboard shortcuts:
  q    Quit dashboard
  w    Watch a task (tail worker output)
  s    Start a task (grove work)
  r    Resume a paused task
  p    Pause a running task
  m    Send a message to a worker

The display refreshes every 5 seconds.`;
  },
};
