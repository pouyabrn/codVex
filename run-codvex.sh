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

tailscale_status_json() {
  local status_json

  if [[ "$(id -u)" -eq 0 ]]; then
    tailscale status --json
    return
  fi

  if status_json="$(tailscale status --json 2>/dev/null)"; then
    printf '%s\n' "$status_json"
    return
  fi

  status_json="$(sudo tailscale status --json 2>/dev/null)"
  printf '%s\n' "$status_json"
}

tailscale_json_first_string() {
  local key="$1"
  local status_json value
  status_json="$(tailscale_status_json 2>/dev/null || true)"
  value="$(printf '%s\n' "$status_json" | sed -n "s/.*\"$key\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1)"
  printf '%s\n' "$value"
}

get_tailscale_auth_url() {
  tailscale_json_first_string "AuthURL"
}

get_tailscale_dns_name() {
  local dns
  dns="$(tailscale_json_first_string "DNSName")"
  dns="${dns%.}"
  printf '%s\n' "$dns"
}

print_tailscale_phone_urls() {
  local dns_name
  dns_name="$(get_tailscale_dns_name)"

  if [[ -n "$dns_name" ]]; then
    echo
    echo "Open on phone:"
    echo "  https://$dns_name/"
    echo "  http://$dns_name/"
    echo
    return
  fi

  echo
  echo "Could not detect the Tailscale DNS name automatically."
  echo "Run: tailscale status --json"
  echo
}

ensure_tailscaled_running() {
  if tailscale_status_json >/dev/null 2>&1; then
    return 0
  fi

  echo "tailscaled is not running. Attempting to start it..."

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl enable --now tailscaled || true
  elif command -v service >/dev/null 2>&1; then
    run_as_root service tailscaled start || true
  fi

  if tailscale_status_json >/dev/null 2>&1; then
    return 0
  fi

  echo "Could not start tailscaled automatically."
  if command -v systemctl >/dev/null 2>&1; then
    echo "Run once:"
    echo "  sudo systemctl enable --now tailscaled"
  elif command -v service >/dev/null 2>&1; then
    echo "Run once:"
    echo "  sudo service tailscaled start"
  else
    echo "No service manager detected. Start tailscaled manually for your distro."
  fi
  echo
  return 1
}

is_tailscale_running() {
  local status_json
  status_json="$(tailscale_status_json 2>/dev/null || true)"
  printf '%s\n' "$status_json" | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'
}

wait_for_tailscale_running() {
  local tries="${1:-8}"
  while (( tries > 0 )); do
    if is_tailscale_running; then
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  return 1
}

ensure_tailscale_login() {
  if wait_for_tailscale_running 2; then
    return 0
  fi

  echo "Tailscale is installed but not logged in yet."
  echo "Starting login flow..."

  # Run interactively so sudo prompts/login URLs are visible immediately.
  local up_log
  up_log="$(mktemp)"
  if run_tailscale up 2>&1 | tee "$up_log"; then
    :
  else
    local up_exit="$?"
    local up_output
    up_output="$(cat "$up_log" 2>/dev/null || true)"
    rm -f "$up_log"
    echo "Could not complete Tailscale login automatically (exit $up_exit)."
    if printf '%s\n' "$up_output" | grep -qi "access denied"; then
      echo "Run once to allow non-root tailscale commands:"
      echo "  sudo tailscale set --operator=$INVOKING_USER"
      echo
    fi
    local auth_url
    auth_url="$(get_tailscale_auth_url)"
    if [[ -n "$auth_url" ]]; then
      echo "Complete login here:"
      echo "  $auth_url"
      echo
    fi
    echo "Run once:"
    echo "  tailscale up"
    echo
    return 1
  fi
  rm -f "$up_log"

  echo "Waiting for Tailscale session to become active (up to 2 minutes)..."
  if wait_for_tailscale_running 120; then
    return 0
  fi

  echo "Tailscale login is still pending."
  local auth_url
  auth_url="$(get_tailscale_auth_url)"
  if [[ -n "$auth_url" ]]; then
    echo "Complete login here:"
    echo "  $auth_url"
  else
    echo "Complete login in the URL shown above, then rerun this command."
  fi
  echo
  return 1
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

start_tailscale_serve() {
  local serve_output=""

  echo "Starting Tailscale Serve for local port $PORT..."
  if serve_output="$(run_tailscale serve --bg "$PORT" 2>&1)"; then
    [[ -n "$serve_output" ]] && printf '%s\n' "$serve_output"
  else
    local serve_exit="$?"
    [[ -n "$serve_output" ]] && printf '%s\n' "$serve_output"

    if printf '%s\n' "$serve_output" | grep -qi "access denied\\|serve config denied"; then
      echo "Tailscale Serve needs operator permission. Applying fix automatically..."
      run_as_root tailscale set --operator="$INVOKING_USER" || true
      if ! serve_output="$(run_tailscale serve --bg "$PORT" 2>&1)"; then
        [[ -n "$serve_output" ]] && printf '%s\n' "$serve_output"
        echo "Could not start Tailscale Serve automatically."
        echo "Run manually: sudo tailscale serve --bg $PORT"
        echo
        return 1
      fi
      [[ -n "$serve_output" ]] && printf '%s\n' "$serve_output"
    else
      echo "Could not start Tailscale Serve automatically (exit $serve_exit)."
      echo "Run manually: sudo tailscale serve --bg $PORT"
      echo
      return 1
    fi
  fi

  # HTTP fallback helps on some phone setups that struggle with HTTPS interception.
  run_tailscale serve --bg --http=80 "$PORT" >/dev/null 2>&1 || true

  echo "Tailscale Serve status:"
  if serve_status="$(run_tailscale serve status)"; then
    printf '%s\n' "$serve_status"
    print_phone_url_from_status "$serve_status"
  else
    echo "Could not read Tailscale Serve status."
    echo "Run manually: tailscale serve status"
    echo
  fi
  print_tailscale_phone_urls
}

if [[ "$ENABLE_TAILSCALE_SERVE" == "1" ]]; then
  if install_tailscale_if_missing; then
    if ensure_tailscaled_running; then
      if ensure_tailscale_login; then
        start_tailscale_serve
      else
        echo "Skipping Tailscale Serve setup until login is completed."
        echo
      fi
    else
      echo "Skipping Tailscale Serve setup because tailscaled is not running."
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
