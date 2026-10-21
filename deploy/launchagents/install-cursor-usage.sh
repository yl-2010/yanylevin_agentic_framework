#!/usr/bin/env bash
# Install / reload com.yanylevin.cursor-usage LaunchAgent.
# Run on the Mac Studio and the MacBook (repo at $HOME/yanylevin_agentic_framework).

set -euo pipefail

REPO="${USAGE_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.yanylevin.cursor-usage"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${USAGE_NODE:-/opt/homebrew/bin/node}"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found at $NODE_BIN (set USAGE_NODE)" >&2
  exit 1
fi
if [[ ! -f "$REPO/server/cursor-usage-collect.js" ]]; then
  echo "missing collector: $REPO/server/cursor-usage-collect.js" >&2
  exit 1
fi
if [[ ! -f "$REPO/server/.env" ]] || ! grep -q '^USAGE_INGEST_TOKEN=.\+' "$REPO/server/.env"; then
  echo "server/.env needs USAGE_INGEST_TOKEN (same value on the Studio and the MacBook)" >&2
  exit 1
fi

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
  launchctl kickstart -k "$SERVICE"
else
  launchctl bootstrap "$DOMAIN" "$DEST"
  launchctl enable "$SERVICE" 2>/dev/null || true
  launchctl kickstart -k "$SERVICE"
fi

echo "installed ${LABEL}"
echo "logs: /tmp/yanylevin-cursor-usage.log"
