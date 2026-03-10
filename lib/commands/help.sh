#!/usr/bin/env bash
# lib/commands/help.sh — grove help
# Show usage overview or detailed help for a specific command.

grove_cmd_help() {
  local topic="${1:-}"

  if [ -n "$topic" ]; then
    # Show detailed help for a specific command
    local func_name="grove_help_${topic//-/_}"
    if type "$func_name" >/dev/null 2>&1; then
      printf '\n'
      "$func_name"
      printf '\n'
    else
      grove_error "No detailed help for: $topic"
      printf 'Run "grove help" for a list of all commands.\n'
    fi
    return 0
  fi

  # Show full help overview
  printf '\n'
  printf '%s  GROVE%s — Unified Development Command Center  (v%s)\n' "$BOLD" "$RESET" "$GROVE_VERSION"
  printf '\n'
  printf '  Usage: grove [COMMAND] [OPTIONS]\n'
  printf '\n'
  printf '  Running "grove" with no arguments opens the HUD.\n'
  printf '\n'

  printf '%s  SETUP%s\n' "$BOLD" "$RESET"
  printf '    init              Initialize Grove (~/.grove, config, database)\n'
  printf '    config            View/edit configuration\n'
  printf '    repos             List configured repositories\n'
  printf '\n'

  printf '%s  TASK MANAGEMENT%s\n' "$BOLD" "$RESET"
  printf '    add               Add a task (interactive or one-liner)\n'
  printf '    tasks             List tasks with filters\n'
  printf '    sync              Pull issues from GitHub repos\n'
  printf '    plan [TASK]       Assign strategy to queued tasks\n'
  printf '    prioritize        Interactive priority adjustment\n'
  printf '\n'

  printf '%s  EXECUTION%s\n' "$BOLD" "$RESET"
  printf '    work [TASK]       Start working (Grove picks batch or specify)\n'
  printf '    resume TASK       Resume a paused task\n'
  printf '    run TASK          Execute non-interactively\n'
  printf '    pause TASK        Pause a running task\n'
  printf '    cancel TASK       Stop and abandon a task\n'
  printf '    detach [TASK]     Let workers continue in background\n'
  printf '\n'

  printf '%s  MONITORING%s\n' "$BOLD" "$RESET"
  printf '    dashboard         Live-updating TUI with all workers\n'
  printf '    watch TASK        Follow a specific worker output\n'
  printf '    msg TASK "..."    Send a message to a running worker\n'
  printf '    log [TASK]        Event log (all or per-task)\n'
  printf '\n'

  printf '%s  REVIEW%s\n' "$BOLD" "$RESET"
  printf '    prs               List all open Grove PRs\n'
  printf '    review            Interactive PR review workflow\n'
  printf '    done TASK         Mark task complete\n'
  printf '    close TASK        Close without completing\n'
  printf '\n'

  printf '%s  REPORTS%s\n' "$BOLD" "$RESET"
  printf '    report [--week]   Generate activity summary\n'
  printf '    cost [--week]     Cost breakdown\n'
  printf '\n'

  printf '%s  OTHER%s\n' "$BOLD" "$RESET"
  printf '    help [COMMAND]    Show this help, or help for a command\n'
  printf '    status            Quick text status summary\n'
  printf '\n'

  printf '  %sConfig:%s  %s\n' "$DIM" "$RESET" "$GROVE_CONFIG"
  printf '  %sData:%s    %s\n' "$DIM" "$RESET" "$GROVE_HOME"
  printf '\n'
}

grove_help_help() {
  printf 'Usage: grove help [COMMAND]\n\n'
  printf 'With no arguments, shows the full command listing.\n'
  printf 'With a command name, shows detailed help for that command.\n\n'
  printf 'Examples:\n'
  printf '  grove help\n'
  printf '  grove help init\n'
  printf '  grove help config\n'
}
