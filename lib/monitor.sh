#!/usr/bin/env bash
# lib/monitor.sh — Worker output monitoring
# Functions for parsing claude -p --output-format stream-json output.

# ---------------------------------------------------------------------------
# grove_monitor_is_alive PID
# Check if a worker process is still running. Returns 0 if alive, 1 if not.
# ---------------------------------------------------------------------------
grove_monitor_is_alive() {
  local pid="$1"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

# ---------------------------------------------------------------------------
# grove_monitor_parse_cost LOG_FILE
# Parse a completed stream-json log file and extract total cost/tokens.
# Prints tab-separated: cost_usd<TAB>input_tokens<TAB>output_tokens
# Stream-json result lines look like:
#   {"type":"result","cost_usd":1.23,"usage":{"input_tokens":5000,"output_tokens":2000}}
# ---------------------------------------------------------------------------
grove_monitor_parse_cost() {
  local log_file="$1"
  if [ ! -f "$log_file" ]; then
    printf '0\t0\t0'
    return 1
  fi
  python3 - "$log_file" << 'PYEOF'
import sys, json

log_file = sys.argv[1]
cost = 0.0
input_tokens = 0
output_tokens = 0

try:
    with open(log_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if obj.get("type") == "result":
                cost = float(obj.get("cost_usd", 0))
                usage = obj.get("usage", {})
                input_tokens = int(usage.get("input_tokens", 0))
                output_tokens = int(usage.get("output_tokens", 0))
except Exception:
    pass

print(f"{cost}\t{input_tokens}\t{output_tokens}")
PYEOF
}

# ---------------------------------------------------------------------------
# grove_monitor_last_activity LOG_FILE
# Return a one-liner describing the most recent activity from the log.
# E.g., "editing src/router.ts", "running tests", "reading config.yaml"
# ---------------------------------------------------------------------------
grove_monitor_last_activity() {
  local log_file="$1"
  if [ ! -f "$log_file" ]; then
    printf 'no log file'
    return 1
  fi
  python3 - "$log_file" << 'PYEOF'
import sys, json

log_file = sys.argv[1]
last_activity = "idle"

try:
    with open(log_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            msg_type = obj.get("type", "")

            # Tool use events
            if msg_type == "tool_use":
                tool = obj.get("tool", obj.get("name", ""))
                tool_input = obj.get("input", {})
                if isinstance(tool_input, dict):
                    # Extract file path from common tool patterns
                    file_path = (tool_input.get("file_path", "")
                                 or tool_input.get("path", "")
                                 or tool_input.get("command", ""))
                else:
                    file_path = ""
                tool_lower = tool.lower()
                if "edit" in tool_lower or "write" in tool_lower:
                    if file_path:
                        # Show just the filename
                        short = file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path
                        last_activity = f"editing {short}"
                    else:
                        last_activity = "editing file"
                elif "read" in tool_lower:
                    if file_path:
                        short = file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path
                        last_activity = f"reading {short}"
                    else:
                        last_activity = "reading file"
                elif "bash" in tool_lower:
                    cmd = tool_input.get("command", "") if isinstance(tool_input, dict) else ""
                    if "test" in cmd or "pytest" in cmd or "jest" in cmd:
                        last_activity = "running tests"
                    elif "git" in cmd:
                        last_activity = "running git command"
                    elif "npm" in cmd or "pip" in cmd or "uv" in cmd:
                        last_activity = "installing dependencies"
                    elif cmd:
                        short = cmd[:40] if len(cmd) > 40 else cmd
                        last_activity = f"running: {short}"
                    else:
                        last_activity = "running command"
                elif "grep" in tool_lower or "glob" in tool_lower:
                    last_activity = "searching codebase"
                else:
                    last_activity = f"using {tool}"

            # Assistant text events
            elif msg_type == "assistant" or msg_type == "text":
                content = obj.get("content", obj.get("text", ""))
                if isinstance(content, str) and len(content) > 10:
                    last_activity = "thinking"

            # Result means done
            elif msg_type == "result":
                last_activity = "completed"

except Exception:
    pass

print(last_activity)
PYEOF
}

# ---------------------------------------------------------------------------
# grove_monitor_stream TASK_ID LOG_FILE
# Parse stream-json output from a log file in real-time.
# Tails the log file, parses JSON lines, extracts events, updates DB.
# Blocks until the worker completes (result event) or the log file stops
# growing and the worker PID is dead.
#
# Expects the worker PID to be stored in the sessions table for this task.
# Prints final cost/token summary on exit.
# ---------------------------------------------------------------------------
grove_monitor_stream() {
  local task_id="$1"
  local log_file="$2"

  if [ ! -f "$log_file" ]; then
    grove_debug "monitor: waiting for log file $log_file"
    # Wait up to 10 seconds for log file to appear
    local wait_count=0
    while [ ! -f "$log_file" ] && [ "$wait_count" -lt 20 ]; do
      sleep 0.5
      wait_count=$(( wait_count + 1 ))
    done
    if [ ! -f "$log_file" ]; then
      grove_error "Log file never appeared: $log_file"
      return 1
    fi
  fi

  # Get session ID and PID for this task
  local session_id
  session_id=$(grove_db_get "SELECT id FROM sessions WHERE task_id = '$(grove_db_escape "$task_id")' AND status = 'running' ORDER BY id DESC LIMIT 1;")
  local worker_pid
  worker_pid=$(grove_db_get "SELECT pid FROM sessions WHERE id = '$session_id';")

  grove_debug "monitor: task=$task_id session=$session_id pid=$worker_pid log=$log_file"

  # Use python3 to tail and parse the stream-json log
  python3 - "$log_file" "$task_id" "$session_id" "$GROVE_DB" "${worker_pid:-0}" << 'PYEOF'
import sys, json, time, os, sqlite3, signal

log_file = sys.argv[1]
task_id = sys.argv[2]
session_id = sys.argv[3]
db_path = sys.argv[4]
worker_pid = int(sys.argv[5]) if len(sys.argv) > 5 else 0

# Track cost updates — only write to DB periodically
last_db_update = 0
DB_UPDATE_INTERVAL = 5  # seconds
accumulated_cost = 0.0
accumulated_input = 0
accumulated_output = 0
completed = False

def pid_alive(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def update_db(cost, input_tokens, output_tokens, force=False):
    global last_db_update
    now = time.time()
    if not force and (now - last_db_update) < DB_UPDATE_INTERVAL:
        return
    last_db_update = now
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        if session_id:
            c.execute("UPDATE sessions SET cost_usd = ?, tokens_used = ? WHERE id = ?",
                       (cost, input_tokens + output_tokens, session_id))
        c.execute("UPDATE tasks SET cost_usd = cost_usd + 0, updated_at = datetime('now') WHERE id = ?",
                   (task_id,))
        conn.commit()
        conn.close()
    except Exception:
        pass

def process_line(line):
    global accumulated_cost, accumulated_input, accumulated_output, completed
    line = line.strip()
    if not line:
        return
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return

    msg_type = obj.get("type", "")

    if msg_type == "result":
        accumulated_cost = float(obj.get("cost_usd", accumulated_cost))
        usage = obj.get("usage", {})
        accumulated_input = int(usage.get("input_tokens", accumulated_input))
        accumulated_output = int(usage.get("output_tokens", accumulated_output))
        update_db(accumulated_cost, accumulated_input, accumulated_output, force=True)
        completed = True
        return

    # Periodic cost from content_block or usage events
    if "usage" in obj:
        usage = obj["usage"]
        accumulated_input = int(usage.get("input_tokens", accumulated_input))
        accumulated_output = int(usage.get("output_tokens", accumulated_output))
    if "cost_usd" in obj:
        accumulated_cost = float(obj["cost_usd"])

    update_db(accumulated_cost, accumulated_input, accumulated_output)

# Tail the file
try:
    with open(log_file, "r") as f:
        stale_count = 0
        while True:
            line = f.readline()
            if line:
                stale_count = 0
                process_line(line)
                if completed:
                    break
            else:
                # No new data
                stale_count += 1
                if stale_count > 20:  # 10 seconds of no data
                    # Check if worker is still alive
                    if worker_pid > 0 and not pid_alive(worker_pid):
                        # Worker died, process remaining lines
                        for remaining in f:
                            process_line(remaining)
                        break
                    stale_count = 10  # Reset partially to keep checking
                time.sleep(0.5)
except KeyboardInterrupt:
    pass

# Final DB update
update_db(accumulated_cost, accumulated_input, accumulated_output, force=True)

# Print summary
print(f"{accumulated_cost}\t{accumulated_input}\t{accumulated_output}")
PYEOF
}
