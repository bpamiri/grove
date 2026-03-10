#!/usr/bin/env bash
# lib/commands/watch.sh — grove watch
# Tail a worker's output log with formatted display.

grove_cmd_watch() {
  grove_require_db

  local task_id="${1:-}"

  if [ -z "$task_id" ]; then
    grove_die "Usage: grove watch TASK_ID"
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Check task is running
  local status
  status=$(grove_db_task_status "$task_id")
  if [ "$status" != "running" ]; then
    grove_die "Task $task_id is not running (status: $status). Only running tasks can be watched."
  fi

  # Find log file: try sessions table first, then glob GROVE_LOG_DIR
  local log_file=""
  local esc_id
  esc_id=$(grove_db_escape "$task_id")

  log_file=$(grove_db_get "SELECT output_log FROM sessions WHERE task_id = '$esc_id' AND status = 'running' ORDER BY started_at DESC LIMIT 1;")

  # If no log from sessions, or file doesn't exist, try log dir glob
  if [ -z "$log_file" ] || [ ! -f "$log_file" ]; then
    local found=""
    for f in "$GROVE_LOG_DIR/${task_id}"-*.log; do
      if [ -f "$f" ]; then
        found="$f"
      fi
    done
    if [ -n "$found" ]; then
      log_file="$found"
    fi
  fi

  if [ -z "$log_file" ] || [ ! -f "$log_file" ]; then
    grove_die "No log file found for task $task_id"
  fi

  local title
  title=$(grove_db_task_get "$task_id" "title")

  printf '%s%sWatching%s %s — %s\n' "$BOLD" "$GREEN" "$RESET" "$task_id" "$(grove_truncate "$title" 50)"
  printf '%sLog:%s %s\n' "$DIM" "$RESET" "$log_file"
  printf '%sPress Ctrl+C to stop watching (worker continues)%s\n\n' "$DIM" "$RESET"

  # Log the watch event
  grove_db_event "$task_id" "watched" "Started watching output"

  # Trap Ctrl+C to exit cleanly without killing the worker
  trap '_grove_watch_exit' INT TERM

  # Tail the log, piping through a formatter
  tail -f "$log_file" 2>/dev/null | _grove_format_log

  return 0
}

# Clean exit from watch — worker keeps running
_grove_watch_exit() {
  printf '\n%s%sStopped watching.%s Worker continues in background.\n' "$BOLD" "$YELLOW" "$RESET"
  # Kill the tail process if still running
  kill %1 2>/dev/null
  trap - INT TERM
  return 0
}

# Format log lines for human-readable output.
# Attempts to parse JSON lines from Claude Code stream output.
# Falls back to plain text for non-JSON lines.
_grove_format_log() {
  while IFS= read -r line; do
    # Skip empty lines
    if [ -z "$line" ]; then
      continue
    fi

    # Try to detect JSON lines and format them
    case "$line" in
      '{'*)
        # Attempt JSON formatting via python3
        local formatted
        formatted=$(printf '%s' "$line" | python3 -c "
import sys, json
try:
    obj = json.load(sys.stdin)
    t = obj.get('type', '')
    # Claude Code streaming events
    if t == 'assistant' or t == 'text':
        text = obj.get('text', obj.get('content', ''))
        if text:
            print(text)
    elif t == 'tool_use':
        name = obj.get('name', obj.get('tool', 'tool'))
        inp = obj.get('input', {})
        if isinstance(inp, dict):
            cmd = inp.get('command', inp.get('file_path', inp.get('pattern', '')))
        else:
            cmd = str(inp)[:80]
        print(f'  \033[0;34m[{name}]\033[0m {cmd[:120]}')
    elif t == 'tool_result' or t == 'result':
        content = obj.get('content', obj.get('output', ''))
        if isinstance(content, str) and len(content) > 200:
            content = content[:200] + '...'
        if content:
            print(f'  \033[2m=> {content}\033[0m')
    elif t == 'error':
        msg = obj.get('message', obj.get('error', str(obj)))
        print(f'  \033[0;31m[error]\033[0m {msg}')
    elif t == 'system':
        msg = obj.get('message', obj.get('text', str(obj)))
        print(f'  \033[2m[system]\033[0m {msg}')
    else:
        # Unknown JSON type — print summary
        keys = ', '.join(obj.keys())
        print(f'  \033[2m[{t or \"data\"}]\033[0m {keys}')
except (json.JSONDecodeError, KeyError, TypeError):
    # Not valid JSON or unexpected structure — pass through
    print(sys.stdin.read() if not line else '', end='')
    sys.exit(1)
" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$formatted" ]; then
          printf '%s\n' "$formatted"
        else
          # Not JSON or formatting failed — print raw
          printf '%s\n' "$line"
        fi
        ;;
      *)
        # Plain text line — print as-is
        printf '%s\n' "$line"
        ;;
    esac
  done
}

grove_help_watch() {
  printf 'Usage: grove watch TASK_ID\n\n'
  printf 'Tail a running worker'\''s output log with formatted display.\n\n'
  printf 'Shows tool usage, file edits, and text output in a\n'
  printf 'human-readable format. JSON stream lines are parsed\n'
  printf 'and colorized.\n\n'
  printf 'Press Ctrl+C to stop watching — the worker continues\n'
  printf 'running in the background.\n\n'
  printf 'Examples:\n'
  printf '  grove watch W-001    Watch worker output for task W-001\n'
}
