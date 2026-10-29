#!/usr/bin/env bash
# Install / reload com.yanylevin.lmstudio-gpt-oss LaunchAgent.
# Mac Studio only. Opens LM Studio at login and loads gpt-oss-20b.

set -euo pipefail

REPO="${YL_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.yanylevin.lmstudio-gpt-oss"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$HOME/.lmstudio/bin/lms" ]]; then
  echo "lms not found at $HOME/.lmstudio/bin/lms" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"

if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]]; then
  /usr/bin/sed -i '' "s|$HOME/yanylevin_agentic_framework|${REPO}|g" "$DEST"
fi

chmod +x "$REPO/deploy/launchagents/load-gpt-oss.sh"

uid="$(id -u)"
DOMAIN="gui/${uid}"
SERVICE="${DOMAIN}/${LABEL}"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || launchctl bootout "$SERVICE" 2>/dev/null || true
fi
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$SERVICE" 2>/dev/null || true
launchctl kickstart -k "$SERVICE"

echo "installed ${LABEL}"
echo "logs: /tmp/yanylevin-lmstudio-gpt-oss.log"
