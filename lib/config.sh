#!/usr/bin/env bash
# lib/config.sh — YAML config loading via python3
# No external dependencies — uses python3's built-in yaml-subset parser.

# Internal: parse YAML and extract a value by dot-notation key.
# Handles the grove.yaml structure (2-3 levels deep).
_grove_config_python() {
  local yaml_file="$1"
  local query="$2"
  python3 - "$yaml_file" "$query" << 'PYEOF'
import sys, os

yaml_file = sys.argv[1]
query = sys.argv[2] if len(sys.argv) > 2 else ""

def parse_yaml(path):
    """Minimal YAML parser for grove.yaml structure (no external deps).
    Handles: scalars, nested maps, simple values. Not a full YAML parser."""
    result = {}
    stack = [result]  # stack of current dicts
    indent_stack = [-1]  # indentation levels
    with open(path) as f:
        for line in f:
            stripped = line.rstrip('\n')
            # Skip empty lines and comments
            if not stripped.strip() or stripped.strip().startswith('#'):
                continue
            # Calculate indent
            indent = len(stripped) - len(stripped.lstrip())
            content = stripped.strip()
            # Pop stack for dedents
            while indent <= indent_stack[-1] and len(indent_stack) > 1:
                indent_stack.pop()
                stack.pop()
            if ':' in content:
                key, _, val = content.partition(':')
                key = key.strip()
                val = val.strip()
                # Remove quotes
                if val and val[0] in ('"', "'") and val[-1] == val[0]:
                    val = val[1:-1]
                if val == '' or val is None:
                    # Nested map
                    new_dict = {}
                    stack[-1][key] = new_dict
                    stack.append(new_dict)
                    indent_stack.append(indent)
                elif val.lower() == 'true':
                    stack[-1][key] = True
                elif val.lower() == 'false':
                    stack[-1][key] = False
                else:
                    # Try numeric
                    try:
                        if '.' in val:
                            stack[-1][key] = float(val)
                        else:
                            stack[-1][key] = int(val)
                    except ValueError:
                        stack[-1][key] = val
    return result

try:
    data = parse_yaml(yaml_file)
except Exception as e:
    print(f"Error parsing {yaml_file}: {e}", file=sys.stderr)
    sys.exit(1)

if not query:
    # Dump all keys for debugging
    def flatten(d, prefix=""):
        for k, v in d.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                flatten(v, path)
            else:
                print(f"{path}={v}")
    flatten(data)
    sys.exit(0)

# Special queries
if query == "__repos__":
    repos = data.get("repos", {})
    for name in repos:
        print(name)
    sys.exit(0)

if query == "__validate__":
    errors = []
    if "workspace" not in data or "name" not in data.get("workspace", {}):
        errors.append("Missing workspace.name")
    if "budgets" not in data:
        errors.append("Missing budgets section")
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        sys.exit(1)
    print("ok")
    sys.exit(0)

if query == "__repo_detail__":
    repos = data.get("repos", {})
    for name, info in repos.items():
        if isinstance(info, dict):
            org = info.get("org", "")
            github = info.get("github", "")
            path = info.get("path", "")
            print(f"{name}\t{org}\t{github}\t{path}")
    sys.exit(0)

# Dot-notation lookup
parts = query.split('.')
current = data
for part in parts:
    if isinstance(current, dict) and part in current:
        current = current[part]
    else:
        sys.exit(1)

if isinstance(current, dict):
    for k, v in current.items():
        print(f"{k}={v}")
else:
    print(current)
PYEOF
}

# Get a config value by dot-notation key.
# Usage: grove_config_get "budgets.per_week"
grove_config_get() {
  grove_require_config
  _grove_config_python "$GROVE_CONFIG" "$1"
}

# List all configured repo names (one per line).
grove_config_repos() {
  grove_require_config
  _grove_config_python "$GROVE_CONFIG" "__repos__"
}

# Get detailed repo info (tab-separated: name, org, github, path).
grove_config_repo_detail() {
  grove_require_config
  _grove_config_python "$GROVE_CONFIG" "__repo_detail__"
}

# Shortcut: get a budget field value.
# Usage: grove_budget_get "per_week"
grove_budget_get() {
  grove_config_get "budgets.$1"
}

# Validate that required fields exist in the config.
# Returns 0 if valid, 1 if errors (printed to stderr).
grove_config_validate() {
  grove_require_config
  _grove_config_python "$GROVE_CONFIG" "__validate__"
}

# Return the workspace name from config.
grove_workspace_name() {
  grove_config_get "workspace.name"
}

# Set a config value via python3 YAML rewrite.
# Usage: grove_config_set "budgets.per_week" "200.00"
grove_config_set() {
  grove_require_config
  local key="$1"
  local value="$2"
  python3 - "$GROVE_CONFIG" "$key" "$value" << 'PYEOF'
import sys

config_file = sys.argv[1]
key = sys.argv[2]
value = sys.argv[3]

with open(config_file) as f:
    lines = f.readlines()

parts = key.split('.')
# Find and replace the target line
# Strategy: track current nesting depth via indentation
target_key = parts[-1]
parent_keys = parts[:-1]

depth = 0
found_parents = 0
result = []
for line in lines:
    stripped = line.rstrip('\n')
    content = stripped.lstrip()
    indent = len(stripped) - len(content)
    expected_indent = found_parents * 2

    if found_parents < len(parent_keys):
        # Looking for parent key
        expected = parent_keys[found_parents]
        if content.startswith(expected + ':') and indent == expected_indent:
            found_parents += 1
            result.append(line)
            continue
    elif found_parents == len(parent_keys):
        # Looking for target key at the right indent
        if content.startswith(target_key + ':') and indent == expected_indent:
            # Replace this line
            spaces = ' ' * indent
            # Detect if value needs quoting
            try:
                float(value)
                formatted = value
            except ValueError:
                if value.lower() in ('true', 'false'):
                    formatted = value
                else:
                    formatted = f'"{value}"'
            result.append(f'{spaces}{target_key}: {formatted}\n')
            found_parents += 1  # prevent further matching
            continue

    result.append(line)

with open(config_file, 'w') as f:
    f.writelines(result)
PYEOF
}
