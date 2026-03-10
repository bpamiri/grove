// grove dashboard — Live-refreshing dashboard with active workers, spend, events, queue
import { getDb, getEnv } from "../core/db";
import { budgetGet } from "../core/config";
import * as ui from "../core/ui";
import { lastActivity, isAlive } from "../lib/monitor";
import type { Command, Task, Session, Event } from "../types";

// ---------------------------------------------------------------------------
// Elapsed time helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Progress bar (unicode blocks with color)
// ---------------------------------------------------------------------------

function progressBar(current: number, max: number, width: number = 24): string {
  if (max <= 0) return "";

  const pct = Math.min(current / max, 1.0);
  const filled = Math.round(pct * width);
  const empty = width - filled;

  // Color thresholds: green <50%, yellow 50-80%, red >80%
  let colorCode: string;
  if (pct >= 0.8) {
    colorCode = "\x1b[0;31m"; // red
  } else if (pct >= 0.5) {
    colorCode = "\x1b[0;33m"; // yellow
  } else {
    colorCode = "\x1b[0;32m"; // green
  }
  const reset = "\x1b[0m";

  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  const pctStr = `${Math.round(pct * 100)}%`;

  return `${colorCode}[${bar}]${reset} ${pctStr}`;
}

// ---------------------------------------------------------------------------
// Horizontal line
// ---------------------------------------------------------------------------

function hline(width: number): string {
  const w = Math.min(width, 80);
  return `  \x1b[2m${"-".repeat(w)}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Draw the full dashboard
// ---------------------------------------------------------------------------

function draw(): void {
  const db = getDb();
  const { GROVE_LOG_DIR } = getEnv();
  const cols = process.stdout.columns || 80;

  // Clear screen
  process.stdout.write("\x1b[2J\x1b[H");

  // Header
  process.stdout.write(
    `\x1b[1m\x1b[32m GROVE DASHBOARD \x1b[0m  \x1b[2mrefresh: 5s\x1b[0m\n`,
  );
  process.stdout.write(hline(cols) + "\n");

  // --- Active Workers ---
  process.stdout.write(`\n  \x1b[1m\x1b[33mACTIVE WORKERS\x1b[0m\n\n`);

  const running = db.all<Task>(
    "SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC",
  );

  if (running.length === 0) {
    process.stdout.write(`    \x1b[2mNo active workers\x1b[0m\n`);
  } else {
    // Header row
    process.stdout.write(
      `    \x1b[1m${"TASK".padEnd(8)} ${"REPO".padEnd(12)} ${"STRATEGY".padEnd(12)} ${"ELAPSED".padEnd(14)} LAST ACTIVITY\x1b[0m\n`,
    );

    for (const t of running) {
      const elapsed = t.started_at ? elapsedTime(t.started_at) : "-";

      // Get last activity from events table
      const lastEvt = db.get<{ summary: string }>(
        "SELECT summary FROM events WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1",
        [t.id],
      );
      const lastAct = lastEvt?.summary ?? "-";

      process.stdout.write(
        `    ${t.id.padEnd(8)} ${ui.truncate(t.repo ?? "-", 10).padEnd(12)} ${ui.truncate(t.strategy ?? "-", 10).padEnd(12)} ${elapsed.padEnd(14)} ${ui.truncate(lastAct, 40)}\n`,
      );
    }
  }

  // --- Session Spend ---
  process.stdout.write("\n" + hline(cols) + "\n");
  process.stdout.write(`\n  \x1b[1m\x1b[34mSESSION SPEND\x1b[0m\n\n`);

  const todayCost = db.costToday();
  const weekCost = db.costWeek();

  let dailyLimit: number;
  let weeklyLimit: number;
  try {
    dailyLimit = budgetGet("per_day") || 25;
  } catch {
    dailyLimit = 25;
  }
  try {
    weeklyLimit = budgetGet("per_week") || 100;
  } catch {
    weeklyLimit = 100;
  }

  process.stdout.write(
    `    Today:  ${ui.dollars(todayCost)} / ${ui.dollars(dailyLimit)}  ${progressBar(todayCost, dailyLimit)}\n`,
  );
  process.stdout.write(
    `    Week:   ${ui.dollars(weekCost)} / ${ui.dollars(weeklyLimit)}  ${progressBar(weekCost, weeklyLimit)}\n`,
  );

  // --- Recent Events ---
  process.stdout.write("\n" + hline(cols) + "\n");
  process.stdout.write(`\n  \x1b[1m\x1b[32mRECENT EVENTS\x1b[0m\n\n`);

  const events = db.recentEvents(10);

  if (events.length === 0) {
    process.stdout.write(`    \x1b[2mNo events yet\x1b[0m\n`);
  } else {
    for (const e of events) {
      const relTime = ui.relativeTime(e.timestamp);
      const taskStr = e.task_id ? `\x1b[34m${e.task_id} \x1b[0m` : "";
      process.stdout.write(
        `    \x1b[2m${relTime.padEnd(16)}\x1b[0m ${taskStr}${ui.truncate(e.summary ?? "", 50)}\n`,
      );
    }
  }

  // --- Queue ---
  process.stdout.write("\n" + hline(cols) + "\n");
  process.stdout.write(`\n  \x1b[1m\x1b[33mQUEUE\x1b[0m\n\n`);

  const readyCount = db.taskCount("ready");

  if (readyCount > 0) {
    process.stdout.write(`    ${readyCount} task(s) ready\n`);

    const readyTasks = db.all<Task>(
      "SELECT * FROM tasks WHERE status = 'ready' ORDER BY priority ASC, created_at ASC LIMIT 5",
    );

    for (const t of readyTasks) {
      process.stdout.write(
        `      \x1b[2m${t.id.padEnd(6)}\x1b[0m ${ui.truncate(t.title, 50)}\n`,
      );
    }

    if (readyCount > 5) {
      process.stdout.write(
        `      \x1b[2m... and ${readyCount - 5} more\x1b[0m\n`,
      );
    }
  } else {
    process.stdout.write(`    \x1b[2mNo tasks queued\x1b[0m\n`);
  }

  // --- Keyboard shortcuts ---
  process.stdout.write("\n" + hline(cols) + "\n");
  process.stdout.write(
    `\n  \x1b[1m[q]\x1b[0m quit  \x1b[1m[w]\x1b[0m watch  \x1b[1m[p]\x1b[0m pause  \x1b[1m[m]\x1b[0m message\n`,
  );
}

// ---------------------------------------------------------------------------
// Interactive prompt helpers (exit raw mode, read line, re-enter raw mode)
// ---------------------------------------------------------------------------

function readLinePrompt(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Exit raw mode for line input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write(prompt);

    const onData = (chunk: Buffer) => {
      process.stdin.removeListener("data", onData);
      const line = chunk.toString().trim();
      // Re-enter raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      resolve(line);
    };
    process.stdin.once("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Dashboard command
// ---------------------------------------------------------------------------

export const dashboardCommand: Command = {
  name: "dashboard",
  description: "Live-refreshing dashboard showing active workers",

  async run() {
    const db = getDb();

    // Initial draw
    draw();

    // Set up refresh interval
    const refreshInterval = setInterval(() => {
      draw();
    }, 5000);

    // Set up raw mode for keyboard input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    const cleanup = () => {
      clearInterval(refreshInterval);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      // Show cursor
      process.stdout.write("\x1b[?25h");
      process.stdout.write("\n");
    };

    // Handle SIGINT gracefully
    const sigHandler = () => {
      cleanup();
      process.exit(0);
    };
    process.on("SIGINT", sigHandler);
    process.on("SIGTERM", sigHandler);

    // Keyboard input handler
    await new Promise<void>((resolve) => {
      process.stdin.on("data", async (key: string) => {
        const ch = key.toLowerCase();

        if (ch === "q" || ch === "\x03") {
          // q or Ctrl+C
          cleanup();
          process.removeListener("SIGINT", sigHandler);
          process.removeListener("SIGTERM", sigHandler);
          resolve();
          return;
        }

        if (ch === "w") {
          // Pause refresh while prompting
          clearInterval(refreshInterval);

          const tid = await readLinePrompt("\n  Task ID to watch: ");
          if (tid) {
            cleanup();
            process.removeListener("SIGINT", sigHandler);
            process.removeListener("SIGTERM", sigHandler);
            resolve();
            // Load and run watch command
            const { watchCommand } = await import("./watch");
            await watchCommand.run([tid]);
            return;
          }
          // Resume — redraw and restart interval
          draw();
          const newInterval = setInterval(() => draw(), 5000);
          // Re-enter raw mode
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          // Note: we can't reassign refreshInterval in this closure,
          // but the old one is already cleared. The new one will be
          // cleared by cleanup() via process exit or q key.
        }

        if (ch === "p") {
          clearInterval(refreshInterval);

          const tid = await readLinePrompt("\n  Task ID to pause: ");
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
            // Brief pause for user to read
            await new Promise((r) => setTimeout(r, 1500));
          }
          draw();
          setInterval(() => draw(), 5000);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
        }

        if (ch === "m") {
          clearInterval(refreshInterval);

          const tid = await readLinePrompt("\n  Task ID: ");
          if (tid) {
            const msg = await readLinePrompt("  Message: ");
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
          draw();
          setInterval(() => draw(), 5000);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
        }
      });
    });
  },

  help() {
    return `Usage: grove dashboard

Live-refreshing dashboard showing all active workers.

Displays:
  - Active workers with elapsed time and last activity
  - Session spend with progress bars (today + week)
  - Last 10 events
  - Queue of ready tasks

Keyboard shortcuts:
  q    Quit dashboard
  w    Watch a task (prompts for ID)
  p    Pause a task (prompts for ID)
  m    Send a message (prompts for ID and text)

The display refreshes every 5 seconds.`;
  },
};
