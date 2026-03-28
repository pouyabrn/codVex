#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./run-codvex.sh [project_dir] [port]
  ./run-codvex.sh [port]

Examples:
  ./run-codvex.sh
  ./run-codvex.sh 3011
  ./run-codvex.sh /path/to/project
  ./run-codvex.sh /path/to/project 3011

Environment variables:
  HOST                     Bind address for CodVex (default: 127.0.0.1)
  ENABLE_TAILSCALE_SERVE   1 to run `tailscale serve --bg` (default), 0 to skip
  AUTO_INSTALL_TAILSCALE   1 to auto-install tailscale when missing (default), 0 to skip
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ORIGINAL_PWD="$(pwd)"

if [[ $# -eq 0 ]]; then
  PROJECT_DIR="$ORIGINAL_PWD"
  PORT="3011"
elif [[ $# -eq 1 ]]; then
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    PROJECT_DIR="$ORIGINAL_PWD"
    PORT="$1"
  else
    PROJECT_DIR="$1"
    PORT="3011"
  fi
elif [[ $# -eq 2 ]]; then
  PROJECT_DIR="$1"
  PORT="$2"
else
  usage
  exit 1
fi

HOST="${HOST:-127.0.0.1}"
ENABLE_TAILSCALE_SERVE="${ENABLE_TAILSCALE_SERVE:-1}"
AUTO_INSTALL_TAILSCALE="${AUTO_INSTALL_TAILSCALE:-1}"
INVOKING_USER="${SUDO_USER:-$(id -un)}"
INVOKING_HOME="$(getent passwd "$INVOKING_USER" | cut -d: -f6)"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Error: project directory does not exist: $PROJECT_DIR" >&2
  exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: port must be a number, got: $PORT" >&2
  exit 1
fi

SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
cd "$SCRIPT_DIR"

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_tailscale() {
  if [[ "$(id -u)" -eq 0 ]]; then
    tailscale "$@"
    return
  fi

  tailscale "$@" || sudo tailscale "$@"
}

install_tailscale_if_missing() {
  if command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$AUTO_INSTALL_TAILSCALE" != "1" ]]; then
    return 1
  fi

  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Auto-install currently supports Linux only."
    return 1
  fi

  echo "tailscale binary not found. Installing tailscale..."

  if ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y curl
    else
      echo "curl is required for tailscale install. Please install curl and retry."
      return 1
    fi
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    curl -fsSL https://tailscale.com/install.sh | sudo sh
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl enable --now tailscaled || true
  fi

  command -v tailscale >/dev/null 2>&1
}

print_phone_url_from_status() {
  local status_text="$1"
  local phone_url
  phone_url="$(printf '%s\n' "$status_text" | grep -Eo 'https://[^[:space:]]+' | head -n 1 || true)"

  if [[ -n "$phone_url" ]]; then
    echo
    echo "Open this URL on phone:"
    echo "  $phone_url"
    echo
  else
    echo
    echo "Could not detect the phone URL automatically."
    echo "Run: tailscale serve status"
    echo
  fi
}

if [[ "$ENABLE_TAILSCALE_SERVE" == "1" ]]; then
  if install_tailscale_if_missing; then
    echo "Starting Tailscale Serve for local port $PORT..."
    if run_tailscale serve --bg "$PORT"; then
      echo "Tailscale Serve status:"
      if serve_status="$(run_tailscale serve status)"; then
        printf '%s\n' "$serve_status"
        print_phone_url_from_status "$serve_status"
      else
        echo "Could not read Tailscale Serve status."
        echo "Run manually: tailscale serve status"
        echo
      fi
    else
      echo "Could not start Tailscale Serve automatically."
      echo "Run manually: sudo tailscale serve --bg $PORT"
      echo
    fi
  else
    echo "tailscale is unavailable; skipping Tailscale Serve setup."
    echo "Install Tailscale manually or run with ENABLE_TAILSCALE_SERVE=0."
    echo
  fi
fi

echo "Starting CodVex"
echo "  Project: $PROJECT_DIR"
echo "  Host:    $HOST"
echo "  Port:    $PORT"
echo

if [[ -n "${SUDO_USER:-}" ]]; then
  echo "Detected sudo execution. Starting CodVex as user '$INVOKING_USER' to keep Codex binary detection working."
  echo
  sudo -u "$INVOKING_USER" -H env \
    HOME="$INVOKING_HOME" \
    HOST="$HOST" \
    PORT="$PORT" \
    CODEX_THREAD_CWD="$PROJECT_DIR" \
    npm start
  exit $?
fi

HOST="$HOST" PORT="$PORT" CODEX_THREAD_CWD="$PROJECT_DIR" npm start
