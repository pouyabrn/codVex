#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/run-codvex.sh"
BIN_DIR="${HOME}/.local/bin"
TARGET="$BIN_DIR/codvex"

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: could not find run-codvex.sh at $SOURCE" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sf "$SOURCE" "$TARGET"

echo "Installed: $TARGET -> $SOURCE"
echo
echo "You can now run:"
echo "  codvex                # current directory, port 3011"
echo "  codvex 3011           # current directory, custom port"
echo "  codvex /path/project  # explicit project"
echo

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "Your PATH does not include $BIN_DIR yet."
  echo "Add this to ~/.bashrc, then restart shell:"
  echo "  export PATH=\"$HOME/.local/bin:\$PATH\""
fi
