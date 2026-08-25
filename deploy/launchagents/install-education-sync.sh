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
launchctl bootout "gui/${uid}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${uid}" "$DEST"
launchctl enable "gui/${uid}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/${uid}/${LABEL}"

echo "installed ${LABEL}"
echo "logs: /tmp/yanylevin-education-sync.log"
echo "check: launchctl print gui/${uid}/${LABEL} | head"
