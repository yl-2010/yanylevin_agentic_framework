#!/usr/bin/env bash
# Install / reload com.yanylevin.brain-data: rebuilds the live /brain/ snapshot every 2 minutes when sources change.
# Mac Studio only (it reads the OneDrive sources and writes ~/Library/Application Support/yanylevin/brain-site).

set -euo pipefail

REPO="${BRAIN_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.yanylevin.brain-data"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

[[ -f "$SRC" ]] || { echo "missing plist: $SRC" >&2; exit 1; }
[[ -f "$REPO/scripts/brain-data/refresh.mjs" ]] || { echo "missing $REPO/scripts/brain-data/refresh.mjs" >&2; exit 1; }

# shellcheck source=service-log-dir.sh
source "$REPO/deploy/launchagents/service-log-dir.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"
if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]]; then
  /usr/bin/sed -i '' -e "s|$HOME/yanylevin_agentic_framework|${REPO}|g" "$DEST"
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
echo "logs: $SERVICE_LOG_DIR/yanylevin-brain-data.log"
