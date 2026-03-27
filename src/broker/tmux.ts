// Grove v3 — tmux session and pane management
// Wraps tmux commands via Bun.spawnSync for synchronous operations
// and Bun.spawn for async ones.

const SESSION_NAME = "grove";

function run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["tmux", ...args]);
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/** Check if the grove tmux session exists */
export function sessionExists(): boolean {
  return run(["has-session", "-t", SESSION_NAME]).ok;
}

/** Create the grove tmux session. Returns false if it already exists. */
export function createSession(): boolean {
  if (sessionExists()) return false;
  const result = run(["new-session", "-d", "-s", SESSION_NAME, "-x", "200", "-y", "50"]);
  return result.ok;
}

/** Kill the grove tmux session and all its panes. */
export function killSession(): boolean {
  if (!sessionExists()) return true;
  return run(["kill-session", "-t", SESSION_NAME]).ok;
}

/** Create a new window in the grove session. Returns the window index. */
export function createWindow(name: string): string | null {
  const result = run([
    "new-window", "-t", SESSION_NAME, "-n", name, "-P", "-F", "#{window_index}",
  ]);
  if (!result.ok) return null;
  return result.stdout;
}

/** Kill a specific window by target (e.g., "grove:1") */
export function killWindow(target: string): boolean {
  return run(["kill-window", "-t", target]).ok;
}

/** Send a bare Enter keystroke to a tmux pane (e.g. to confirm a prompt). */
export function sendEnter(target: string): boolean {
  return run(["send-keys", "-t", target, "Enter"]).ok;
}

/** Send keys (text input) to a tmux pane. */
export function sendKeys(target: string, text: string): boolean {
  // For long messages, use a temp file to avoid shell escaping issues
  if (text.length > 500) {
    return sendKeysViaFile(target, text);
  }
  // Escape single quotes for shell safety
  const escaped = text.replace(/'/g, "'\\''");
  return run(["send-keys", "-t", target, escaped, "Enter"]).ok;
}

/** Send keys via a temp file for long messages (avoids escaping issues) */
function sendKeysViaFile(target: string, text: string): boolean {
  const tmpFile = `/tmp/grove-sendkeys-${Date.now()}.txt`;
  try {
    Bun.spawnSync(["bash", "-c", `cat > '${tmpFile}'`], {
      stdin: new TextEncoder().encode(text),
    });
    // Use load-buffer to send the file content
    const loadResult = run(["load-buffer", tmpFile]);
    if (!loadResult.ok) return false;
    const pasteResult = run(["paste-buffer", "-t", target, "-d"]);
    run(["send-keys", "-t", target, "Enter"]);
    return pasteResult.ok;
  } finally {
    try { Bun.spawnSync(["rm", "-f", tmpFile]); } catch {}
  }
}

/** Capture the current content of a tmux pane. */
export function capturePane(target: string, lines: number = 100): string {
  const result = run([
    "capture-pane", "-t", target, "-p", "-S", `-${lines}`,
  ]);
  return result.ok ? result.stdout : "";
}

/** List all windows in the grove session. Returns [{index, name}] */
export function listWindows(): Array<{ index: string; name: string }> {
  if (!sessionExists()) return [];
  const result = run([
    "list-windows", "-t", SESSION_NAME, "-F", "#{window_index}\t#{window_name}",
  ]);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\n").map((line) => {
    const [index, name] = line.split("\t");
    return { index, name };
  });
}

/** Get the full target string for a window (e.g., "grove:orchestrator") */
export function windowTarget(windowName: string): string {
  return `${SESSION_NAME}:${windowName}`;
}

/** Run a command in a new tmux window. Returns the window index. */
export function runInWindow(name: string, command: string): string | null {
  const result = run([
    "new-window", "-t", SESSION_NAME, "-n", name,
    "-P", "-F", "#{window_index}",
    command,
  ]);
  if (!result.ok) return null;
  return result.stdout;
}

/** Check if tmux is installed and available */
export function isTmuxAvailable(): boolean {
  const result = Bun.spawnSync(["which", "tmux"]);
  return result.exitCode === 0;
}

/** Get the PID of the process running in a tmux pane */
export function panePid(target: string): number | null {
  const result = run(["display-message", "-t", target, "-p", "#{pane_pid}"]);
  if (!result.ok || !result.stdout) return null;
  const pid = parseInt(result.stdout, 10);
  return isNaN(pid) ? null : pid;
}
