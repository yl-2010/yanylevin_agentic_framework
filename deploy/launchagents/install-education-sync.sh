#!/usr/bin/env bash
# Install / reload com.personalagent.education-sync LaunchAgent.
# Run on Mac Studio and MacBook (repo at $HOME/yanylevin_agentic_framework).

set -euo pipefail

REPO="${EDU_SYNC_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.personalagent.education-sync"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${EDU_SYNC_NODE:-/opt/homebrew/bin/node}"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found at $NODE_BIN (set EDU_SYNC_NODE)" >&2
  exit 1
fi
if [[ ! -f "$REPO/scripts/education-folder-sync.mjs" ]]; then
  echo "missing sync script: $REPO/scripts/education-folder-sync.mjs" >&2
  exit 1
fi

# shellcheck source=service-log-dir.sh
source "$REPO/deploy/launchagents/service-log-dir.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"

# Rewrite paths if this checkout isn't the default location.
if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]] || [[ "$NODE_BIN" != "/opt/homebrew/bin/node" ]]; then
  /usr/bin/sed -i '' \
    -e "s|$HOME/yanylevin_agentic_framework|${REPO}|g" \
    -e "s|/opt/homebrew/bin/node|${NODE_BIN}|g" \
    "$DEST"
fi

uid="$(id -u)"
DOMAIN="gui/${uid}"
SERVICE="${DOMAIN}/${LABEL}"

# bootout+bootstrap so StandardOutPath and other plist edits take effect.
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE" 2>/dev/null || launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
  sleep 1
fi
yl_bootstrap_agent "$DOMAIN" "$DEST"
launchctl enable "$SERVICE" 2>/dev/null || true
launchctl kickstart -k "$SERVICE"

echo "installed ${LABEL}"
echo "logs: $SERVICE_LOG_DIR/personal-agent-education-sync.log"
echo "check: launchctl print gui/${uid}/${LABEL} | head"
