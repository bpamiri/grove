#!/usr/bin/env bash
# lib/commands/msg.sh — grove msg
# Queue a message for a running worker.

grove_cmd_msg() {
  grove_require_db

  local task_id="${1:-}"
  shift 2>/dev/null || true
  local message="$*"

  if [ -z "$task_id" ]; then
    grove_die "Usage: grove msg TASK_ID \"message text\""
  fi

  if [ -z "$message" ]; then
    grove_die "Usage: grove msg TASK_ID \"message text\""
  fi

  # Verify task exists
  if ! grove_db_exists "tasks" "id = '$(grove_db_escape "$task_id")'"; then
    grove_die "Task not found: $task_id"
  fi

  # Verify task is running
  local status
  status=$(grove_db_task_status "$task_id")
  if [ "$status" != "running" ]; then
    grove_die "Task $task_id is not running (status: $status). Messages can only be sent to running tasks."
  fi

  # Write message to the message file
  local msg_file="$GROVE_LOG_DIR/${task_id}.msg"

  # Ensure log directory exists
  if [ ! -d "$GROVE_LOG_DIR" ]; then
    mkdir -p "$GROVE_LOG_DIR"
  fi

  # Append message with timestamp (allows multiple queued messages)
  local ts
  ts=$(grove_timestamp)
  printf '[%s] %s\n' "$ts" "$message" >> "$msg_file"

  # Log event
  grove_db_event "$task_id" "message_sent" "Message queued: $(grove_truncate "$message" 80)"

  local title
  title=$(grove_db_task_get "$task_id" "title")

  grove_success "Message queued for $task_id"
  printf '  %sTask:%s    %s\n' "$DIM" "$RESET" "$(grove_truncate "$title" 50)"
  printf '  %sMessage:%s %s\n' "$DIM" "$RESET" "$(grove_truncate "$message" 60)"
  printf '  %sFile:%s    %s\n' "$DIM" "$RESET" "$msg_file"
  printf '\n'
  printf '%sNote: Message will be read when the task is next resumed or%s\n' "$DIM" "$RESET"
  printf '%sinteracted with. Claude Code -p sessions do not accept live input.%s\n' "$DIM" "$RESET"
}

grove_help_msg() {
  printf 'Usage: grove msg TASK_ID "message text"\n\n'
  printf 'Queue a message for a running worker.\n\n'
  printf 'Since Claude Code -p sessions do not accept live input,\n'
  printf 'messages are written to a file that gets read when the\n'
  printf 'task is resumed or the worker checks for messages.\n\n'
  printf 'Multiple messages can be queued — they are appended with\n'
  printf 'timestamps.\n\n'
  printf 'Examples:\n'
  printf '  grove msg W-001 "Focus on the test failures first"\n'
  printf '  grove msg W-001 "Skip the linting for now"\n'
}
