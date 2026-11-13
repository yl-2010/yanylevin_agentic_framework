#!/usr/bin/env bash
# Shared service-log location for install and rotate scripts.
SERVICE_LOG_DIR="${SERVICE_LOG_DIR:-$HOME/Library/Logs/yanylevin}"
SERVICE_LOG_ARCHIVE_DIR="${SERVICE_LOG_ARCHIVE_DIR:-$SERVICE_LOG_DIR/archive}"
mkdir -p "$SERVICE_LOG_DIR" "$SERVICE_LOG_ARCHIVE_DIR"

# Bootstrap a LaunchAgent, retrying once if launchd returns I/O error 5.
yl_bootstrap_agent() {
  local domain="$1" dest="$2"
  if launchctl bootstrap "$domain" "$dest"; then
    return 0
  fi
  echo "bootstrap failed for $dest; retrying in 3s" >&2
  sleep 3
  launchctl bootstrap "$domain" "$dest"
}
