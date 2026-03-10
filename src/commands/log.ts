// grove log — Event timeline
import { getDb } from "../core/db";
import * as ui from "../core/ui";
import type { Command, Event } from "../types";

function eventColor(eventType: string): string {
  switch (eventType) {
    case "created": return "blue";
    case "planned": return "blue";
    case "started": return "green";
    case "resumed": return "green";
    case "worker_spawned": return "green";
    case "paused": return "yellow";
    case "cancelled": return "yellow";
    case "failed": return "red";
    case "completed": return "boldgreen";
    case "status_change": return "dim";
    case "synced": return "blue";
    case "pr_created": return "blue";
    case "auto_approved": return "green";
    default: return "dim";
  }
}

function colorizeType(eventType: string): string {
  const color = eventColor(eventType);
  switch (color) {
    case "blue": return ui.pc.blue(eventType);
    case "green": return ui.pc.green(eventType);
    case "yellow": return ui.pc.yellow(eventType);
    case "red": return ui.pc.red(eventType);
    case "boldgreen": return ui.bold(ui.pc.green(eventType));
    case "dim": return ui.dim(eventType);
    default: return eventType;
  }
}

function formatTimestamp(timestamp: string): string {
  // Use relative time for recent events, absolute for older
  const normalized = timestamp.replace(" ", "T") + (timestamp.includes("Z") || timestamp.includes("+") ? "" : "Z");
  const dt = new Date(normalized);
  if (isNaN(dt.getTime())) return timestamp;

  const ageMs = Date.now() - dt.getTime();
  const threeDays = 3 * 86400 * 1000;

  if (ageMs < threeDays) {
    return ui.relativeTime(timestamp);
  }
  // Absolute for older events
  return timestamp.replace("T", " ").slice(0, 16);
}

export const logCommand: Command = {
  name: "log",
  description: "Event timeline",

  async run(args: string[]) {
    const db = getDb();

    let taskId = "";
    let filterRepo = "";
    let filterType = "";
    let limit = 20;
    let showAll = false;

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if ((arg === "--repo" || arg === "-r") && i + 1 < args.length) {
        filterRepo = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--repo=")) {
        filterRepo = arg.slice("--repo=".length);
        i++;
      } else if ((arg === "--type" || arg === "-t") && i + 1 < args.length) {
        filterType = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--type=")) {
        filterType = arg.slice("--type=".length);
        i++;
      } else if ((arg === "--limit" || arg === "-n") && i + 1 < args.length) {
        limit = parseInt(args[i + 1], 10) || 20;
        i += 2;
      } else if (arg.startsWith("--limit=")) {
        limit = parseInt(arg.slice("--limit=".length), 10) || 20;
        i++;
      } else if (arg === "--all" || arg === "-a") {
        showAll = true;
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else if (!arg.startsWith("-")) {
        taskId = arg;
        i++;
      } else {
        ui.warn(`Unknown option: ${arg}`);
        i++;
      }
    }

    // Build query
    const conditions: string[] = [];
    const params: any[] = [];

    if (taskId) {
      conditions.push("e.task_id = ?");
      params.push(taskId);
    }

    if (filterRepo) {
      conditions.push("(e.repo = ? OR e.task_id IN (SELECT id FROM tasks WHERE repo = ?))");
      params.push(filterRepo, filterRepo);
    }

    if (filterType) {
      conditions.push("e.event_type = ?");
      params.push(filterType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const effectiveLimit = showAll ? 1000 : limit;

    const events = db.all<Event>(
      `SELECT e.* FROM events e ${where} ORDER BY e.timestamp DESC LIMIT ?`,
      [...params, effectiveLimit],
    );

    if (events.length === 0) {
      ui.info("No events found.");
      return;
    }

    // Header
    const context = taskId
      ? `Task ${taskId}`
      : filterRepo
        ? `Repo ${filterRepo}`
        : "All";
    ui.header(`Event Log — ${context}`);

    // Display events
    for (const e of events) {
      const ts = formatTimestamp(e.timestamp);
      const type = colorizeType(e.event_type);
      const taskStr = e.task_id ? ui.dim(` ${e.task_id}`) : "";
      const summaryStr = e.summary ? ` ${e.summary}` : "";

      console.log(`  ${ui.pad(ts, 18)} ${ui.pad(type, 26)}${taskStr}${summaryStr}`);
    }

    console.log(`\n${ui.dim(`${events.length} event(s)`)}`);
  },

  help() {
    return [
      "Usage: grove log [TASK_ID] [OPTIONS]",
      "",
      "Show event timeline.",
      "",
      "Options:",
      "  --repo, -r NAME     Filter by repo",
      "  --type, -t TYPE     Filter by event type",
      "  --limit, -n N       Number of events to show (default: 20)",
      "  --all, -a           Show all events (up to 1000)",
      "",
      "Event types: created, planned, started, paused, resumed, worker_spawned,",
      "  file_modified, tests_passed, pr_created, completed, failed, synced,",
      "  status_change, message_sent, message_received, cancelled, detached",
      "",
      "Color coding:",
      "  Blue: created, planned, synced, pr_created",
      "  Green: started, resumed, completed",
      "  Yellow: paused, cancelled",
      "  Red: failed",
    ].join("\n");
  },
};
