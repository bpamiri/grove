#!/usr/bin/env bash
# lib/utils.sh — Colors, formatting, logging, prompts
# All utility functions used across Grove.

# ---------------------------------------------------------------------------
# Color setup — respects NO_COLOR and non-terminal output
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
else
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  BOLD=""
  DIM=""
  RESET=""
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# Print an info message with blue "[grove]" prefix
grove_info() {
  printf '%s[grove]%s %s\n' "$BLUE" "$RESET" "$*"
}

# Print a success message with green checkmark
grove_success() {
  printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"
}

# Print a warning message with yellow warning sign
grove_warn() {
  printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$*"
}

# Print an error message to stderr with red X
grove_error() {
  printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2
}

# Print error and exit with given code (default 1)
grove_die() {
  grove_error "$1"
  exit "${2:-1}"
}

# Print debug message only when GROVE_DEBUG=1
grove_debug() {
  if [ "${GROVE_DEBUG:-0}" = "1" ]; then
    printf '%s[debug]%s %s\n' "$DIM" "$RESET" "$*" >&2
  fi
}

# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

# Print a bold centered header
grove_header() {
  local text="$1"
  local width=60
  local pad
  pad=$(( (width - ${#text}) / 2 ))
  if [ "$pad" -lt 0 ]; then pad=0; fi
  local spaces=""
  local i=0
  while [ "$i" -lt "$pad" ]; do
    spaces="$spaces "
    i=$(( i + 1 ))
  done
  printf '\n%s%s%s%s\n\n' "$BOLD" "$spaces" "$text" "$RESET"
}

# Print a colored inline badge like "[running]"
grove_badge() {
  local label="$1"
  local color="$2"
  local color_code=""
  case "$color" in
    red)    color_code="$RED" ;;
    green)  color_code="$GREEN" ;;
    yellow) color_code="$YELLOW" ;;
    blue)   color_code="$BLUE" ;;
    *)      color_code="" ;;
  esac
  printf '%s[%s]%s' "$color_code" "$label" "$RESET"
}

# ---------------------------------------------------------------------------
# Interactive prompts
# ---------------------------------------------------------------------------

# Y/N confirmation. Returns 0 for yes, 1 for no.
# Usage: grove_confirm "Overwrite?" "y"  (default yes)
grove_confirm() {
  local prompt="$1"
  local default="${2:-n}"
  local yn_hint
  if [ "$default" = "y" ] || [ "$default" = "Y" ]; then
    yn_hint="[Y/n]"
  else
    yn_hint="[y/N]"
  fi
  printf '%s %s ' "$prompt" "$yn_hint"
  read -r answer
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|Yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Numbered menu selection. Prints selected option to stdout.
# Usage: choice=$(grove_choose "Pick one:" "alpha" "beta" "gamma")
grove_choose() {
  local prompt="$1"
  shift
  local options=("$@")
  local count=${#options[@]}
  printf '%s\n' "$prompt" >&2
  local i=1
  for opt in "${options[@]}"; do
    printf '  %s[%d]%s %s\n' "$BOLD" "$i" "$RESET" "$opt" >&2
    i=$(( i + 1 ))
  done
  local selection
  while true; do
    printf 'Choice: ' >&2
    read -r selection
    if [ -n "$selection" ] && [ "$selection" -ge 1 ] 2>/dev/null && [ "$selection" -le "$count" ] 2>/dev/null; then
      printf '%s' "${options[$(( selection - 1 ))]}"
      return 0
    fi
    printf 'Please enter a number between 1 and %d.\n' "$count" >&2
  done
}

# ---------------------------------------------------------------------------
# Date/time helpers
# ---------------------------------------------------------------------------

# Return ISO 8601 UTC datetime string
grove_timestamp() {
  python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))"
}

# Convert ISO timestamp to relative time string ("2 hours ago", etc.)
grove_relative_time() {
  local ts="$1"
  python3 -c "
import sys
from datetime import datetime, timezone

ts = sys.argv[1].replace('Z', '+00:00')
try:
    dt = datetime.fromisoformat(ts)
except ValueError:
    # Handle format without timezone
    dt = datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
diff = now - dt
seconds = int(diff.total_seconds())
if seconds < 0:
    print('just now')
elif seconds < 60:
    print(f'{seconds} seconds ago')
elif seconds < 3600:
    m = seconds // 60
    print(f'{m} minute{\"s\" if m != 1 else \"\"} ago')
elif seconds < 86400:
    h = seconds // 3600
    print(f'{h} hour{\"s\" if h != 1 else \"\"} ago')
elif seconds < 604800:
    d = seconds // 86400
    print(f'{d} day{\"s\" if d != 1 else \"\"} ago')
else:
    w = seconds // 604800
    print(f'{w} week{\"s\" if w != 1 else \"\"} ago')
" "$ts"
}

# ---------------------------------------------------------------------------
# String formatting
# ---------------------------------------------------------------------------

# Format a numeric amount as dollars: grove_dollars 12.5 → "$12.50"
grove_dollars() {
  python3 -c "import sys; print(f'\${float(sys.argv[1]):.2f}')" "$1"
}

# Truncate a string with "..." if it exceeds max length
grove_truncate() {
  local str="$1"
  local maxlen="$2"
  if [ "${#str}" -le "$maxlen" ]; then
    printf '%s' "$str"
  else
    local cut=$(( maxlen - 3 ))
    printf '%s...' "${str:0:$cut}"
  fi
}

# Right-pad a string with spaces to given width
grove_pad() {
  local str="$1"
  local width="$2"
  printf "%-${width}s" "$str"
}

# ---------------------------------------------------------------------------
# Requirement checks
# ---------------------------------------------------------------------------

# Verify that all given commands exist on PATH, or die
grove_require() {
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      grove_die "Required command not found: $cmd"
    fi
  done
}

# Check that the Grove database exists
grove_require_db() {
  if [ ! -f "$GROVE_DB" ]; then
    grove_die "Grove database not found. Run 'grove init' first."
  fi
}

# Check that the Grove config file exists
grove_require_config() {
  if [ ! -f "$GROVE_CONFIG" ]; then
    grove_die "Grove config not found at $GROVE_CONFIG. Run 'grove init' first."
  fi
}
