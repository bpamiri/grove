#!/usr/bin/env bash
# lib/commands/init.sh — grove init
# Sets up ~/.grove directory, config, and database.

grove_cmd_init() {
  grove_header "Grove Init"

  grove_require python3 sqlite3

  # Create GROVE_HOME directory
  if [ ! -d "$GROVE_HOME" ]; then
    mkdir -p "$GROVE_HOME"
    grove_success "Created $GROVE_HOME"
  else
    grove_info "Directory exists: $GROVE_HOME"
  fi

  # Create log directory
  if [ ! -d "$GROVE_LOG_DIR" ]; then
    mkdir -p "$GROVE_LOG_DIR"
    grove_success "Created $GROVE_LOG_DIR"
  fi

  # Copy example config if none exists
  local example_config="$GROVE_ROOT/grove.yaml.example"
  if [ ! -f "$GROVE_CONFIG" ]; then
    if [ -f "$example_config" ]; then
      cp "$example_config" "$GROVE_CONFIG"
      grove_success "Created config: $GROVE_CONFIG"
    else
      grove_warn "Example config not found at $example_config"
      grove_warn "You'll need to create $GROVE_CONFIG manually."
    fi
  else
    grove_info "Config already exists: $GROVE_CONFIG"
    if grove_confirm "  Overwrite with example config?"; then
      cp "$example_config" "$GROVE_CONFIG"
      grove_success "Config overwritten."
    fi
  fi

  # Initialize the database
  if [ ! -f "$GROVE_DB" ]; then
    grove_db_init
    grove_success "Database created: $GROVE_DB"
  else
    grove_info "Database already exists: $GROVE_DB"
    # Run schema anyway to create any missing tables (IF NOT EXISTS)
    grove_db_init
    grove_success "Database schema updated."
  fi

  # Store init timestamp in db config
  grove_db_config_set "initialized_at" "$(grove_timestamp)"
  grove_db_config_set "grove_version" "$GROVE_VERSION"

  # Log the event
  grove_db_event "" "initialized" "Grove initialized (v$GROVE_VERSION)"

  printf '\n'
  grove_success "Grove is ready!"
  printf '\n'
  grove_info "Next steps:"
  printf '  1. Edit your config:  %s\n' "$GROVE_CONFIG"
  printf '  2. Add your repos to the config file\n'
  printf '  3. Run: grove repos    (to verify)\n'
  printf '  4. Run: grove help     (to see all commands)\n'
  printf '\n'
}

grove_help_init() {
  printf 'Usage: grove init\n\n'
  printf 'Initialize Grove by creating the ~/.grove directory,\n'
  printf 'configuration file, and SQLite database.\n\n'
  printf 'This is safe to run multiple times — it will not overwrite\n'
  printf 'existing config without confirmation, and the database\n'
  printf 'schema uses IF NOT EXISTS.\n'
}
