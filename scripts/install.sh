#!/bin/bash
# Grove installer — detects platform, downloads latest release binary
set -euo pipefail

REPO="bpamiri/grove"
INSTALL_DIR="${GROVE_INSTALL_DIR:-/usr/local/bin}"

echo "Installing Grove..."

# Get latest version
VERSION=$(curl -sS "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "Error: Could not determine latest version." >&2
  exit 1
fi
echo "  Version: $VERSION"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "Error: Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
echo "  Platform: $OS/$ARCH"

BINARY="grove-${OS}-${ARCH}"
URL="https://github.com/$REPO/releases/download/$VERSION/${BINARY}.tar.gz"

# Download and install
echo "  Downloading $URL..."
curl -fsSL "$URL" | tar xz -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/grove"

echo ""
echo "Grove $VERSION installed to $INSTALL_DIR/grove"
echo "Run 'grove init' to get started."
