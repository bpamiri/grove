#!/usr/bin/env bash
# lib/commands/config-cmd.sh — grove config
# View and edit Grove configuration.

grove_cmd_config_cmd() {
  local subcmd="${1:-}"

  case "$subcmd" in
    "")
      # No args: print current config
      grove_require_config
      grove_header "Grove Configuration"
      printf '%s%s%s\n\n' "$DIM" "$GROVE_CONFIG" "$RESET"
      # Try bat/pygmentize for syntax highlighting, fall back to cat
      if command -v bat >/dev/null 2>&1; then
        bat --style=plain --language=yaml "$GROVE_CONFIG"
      elif command -v pygmentize >/dev/null 2>&1; then
        pygmentize -l yaml "$GROVE_CONFIG"
      else
        cat "$GROVE_CONFIG"
      fi
      ;;

    get)
      # grove config get KEY
      local key="${2:-}"
      if [ -z "$key" ]; then
        grove_die "Usage: grove config get KEY"
      fi
      grove_config_get "$key"
      ;;

    set)
      # grove config set KEY VALUE
      local key="${2:-}"
      local value="${3:-}"
      if [ -z "$key" ] || [ -z "$value" ]; then
        grove_die "Usage: grove config set KEY VALUE"
      fi
      grove_config_set "$key" "$value"
      grove_success "Set $key = $value"
      ;;

    edit)
      # grove config edit — open in editor
      grove_require_config
      local editor="${EDITOR:-vi}"
      "$editor" "$GROVE_CONFIG"
      # Validate after edit
      if grove_config_validate >/dev/null 2>&1; then
        grove_success "Config is valid."
      else
        grove_warn "Config has issues. Run 'grove config' to review."
      fi
      ;;

    *)
      grove_die "Unknown config subcommand: $subcmd. Try: get, set, edit"
      ;;
  esac
}

# Alias: "grove config" dispatches to grove_cmd_config
grove_cmd_config() { grove_cmd_config_cmd "$@"; }

grove_help_config() { grove_help_config_cmd "$@"; }

grove_help_config_cmd() {
  printf 'Usage: grove config [SUBCOMMAND]\n\n'
  printf 'View and edit Grove configuration.\n\n'
  printf 'Subcommands:\n'
  printf '  (none)          Show current configuration\n'
  printf '  get KEY         Get a specific config value (dot notation)\n'
  printf '  set KEY VALUE   Set a config value\n'
  printf '  edit            Open config in $EDITOR\n\n'
  printf 'Examples:\n'
  printf '  grove config\n'
  printf '  grove config get budgets.per_week\n'
  printf '  grove config set budgets.per_week 200.00\n'
  printf '  grove config edit\n'
}
