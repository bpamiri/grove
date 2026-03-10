// Grove v2 — Colors, formatting, logging (picocolors-based)
import pc from "picocolors";

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function info(msg: string): void {
  console.log(`${pc.blue("[grove]")} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow("⚠")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${pc.red("✗")} ${msg}`);
}

export function die(msg: string, code: number = 1): never {
  error(msg);
  process.exit(code);
}

export function debug(msg: string): void {
  if (process.env.GROVE_DEBUG === "1") {
    console.error(`${pc.dim("[debug]")} ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function header(text: string): void {
  const width = 60;
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  console.log(`\n${" ".repeat(pad)}${pc.bold(text)}\n`);
}

export function badge(label: string, color: string): string {
  switch (color) {
    case "red": return pc.red(`[${label}]`);
    case "green": return pc.green(`[${label}]`);
    case "yellow": return pc.yellow(`[${label}]`);
    case "blue": return pc.blue(`[${label}]`);
    case "dim": return pc.dim(`[${label}]`);
    default: return `[${label}]`;
  }
}

/** Color a status badge appropriately */
export function statusBadge(status: string): string {
  switch (status) {
    case "ingested": return badge(status, "dim");
    case "planned": return badge(status, "blue");
    case "ready": return badge(status, "blue");
    case "running": return badge(status, "green");
    case "paused": return badge(status, "yellow");
    case "done": return badge(status, "green");
    case "review": return badge(status, "yellow");
    case "completed": return pc.bold(pc.green(`[${status}]`));
    case "failed": return badge(status, "red");
    default: return badge(status, "dim");
  }
}

/** Format a number as dollars: 12.5 → "$12.50" */
export function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Truncate a string with "..." if it exceeds max length */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/** Right-pad a string with spaces to given width */
export function pad(str: string, width: number): string {
  return str.padEnd(width);
}

/** Convert ISO timestamp to relative time string ("2 hours ago", etc.) */
export function relativeTime(timestamp: string): string {
  const now = Date.now();
  let dt: Date;
  try {
    // Handle SQLite datetime format "YYYY-MM-DD HH:MM:SS"
    const normalized = timestamp.replace(" ", "T").replace(/Z$/, "") + (timestamp.includes("Z") || timestamp.includes("+") ? "" : "Z");
    dt = new Date(normalized);
  } catch {
    return timestamp;
  }

  if (isNaN(dt.getTime())) return timestamp;

  const seconds = Math.floor((now - dt.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m !== 1 ? "s" : ""} ago`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `${h} hour${h !== 1 ? "s" : ""} ago`;
  }
  if (seconds < 604800) {
    const d = Math.floor(seconds / 86400);
    return `${d} day${d !== 1 ? "s" : ""} ago`;
  }
  const w = Math.floor(seconds / 604800);
  return `${w} week${w !== 1 ? "s" : ""} ago`;
}

/** Format minutes as human-readable duration */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Bold text */
export function bold(text: string): string {
  return pc.bold(text);
}

/** Dim text */
export function dim(text: string): string {
  return pc.dim(text);
}

/** Print the Grove logo */
export function logo(): void {
  const g = pc.green;
  const d = pc.dim;
  console.log();
  console.log(g("   ╔═══╗ ╔═══╗ ╔═══╗ ╦   ╦ ╔═══╗"));
  console.log(g("   ║     ║   ║ ║   ║ ║   ║ ║    "));
  console.log(g("   ║ ╔═╗ ╠═══╝ ║   ║ ╚╗ ╔╝ ╠═══ "));
  console.log(g("   ║   ║ ║  ╚╗ ║   ║  ║ ║  ║    "));
  console.log(g("   ╚═══╝ ╩   ╩ ╚═══╝  ╚═╝  ╚═══╝"));
  console.log(d("   development command center"));
  console.log();
}

// Re-export picocolors for direct use
export { pc };
