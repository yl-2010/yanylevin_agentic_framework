#!/usr/bin/env bash
# Install / reload com.yanylevin.onedrive-backup on the Mac Studio.
# The job copies OneDrive backend data to local disk once an hour.

set -euo pipefail

if ! hostname | grep -qi 'Mac-Studio' && ! scutil --get ComputerName | grep -qi 'Mac Studio'; then
  echo "skip: not Mac Studio"
  exit 0
fi

REPO="${ONEDRIVE_BACKUP_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.yanylevin.onedrive-backup"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${ONEDRIVE_BACKUP_NODE:-/opt/homebrew/bin/node}"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found at $NODE_BIN (set ONEDRIVE_BACKUP_NODE)" >&2
  exit 1
fi
if [[ ! -f "$REPO/scripts/onedrive-backend-backup.mjs" ]]; then
  echo "missing backup script: $REPO/scripts/onedrive-backend-backup.mjs" >&2
  exit 1
fi

# shellcheck source=service-log-dir.sh
source "$REPO/deploy/launchagents/service-log-dir.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"

if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]] || [[ "$NODE_BIN" != "/opt/homebrew/bin/node" ]]; then
  /usr/bin/sed -i '' \
    -e "s|$HOME/yanylevin_agentic_framework|${REPO}|g" \
    -e "s|/opt/homebrew/bin/node|${NODE_BIN}|g" \
    "$DEST"
fi

uid="$(id -u)"
DOMAIN="gui/${uid}"
SERVICE="${DOMAIN}/${LABEL}"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE" 2>/dev/null || launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
  sleep 1
fi
yl_bootstrap_agent "$DOMAIN" "$DEST"
launchctl enable "$SERVICE" 2>/dev/null || true
launchctl kickstart -k "$SERVICE"

echo "installed ${LABEL}"
echo "logs: $SERVICE_LOG_DIR/yanylevin-onedrive-backup.log"
echo "check: launchctl print gui/${uid}/${LABEL} | head"
