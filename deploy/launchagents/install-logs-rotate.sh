#!/usr/bin/env bash
# Install / reload com.personalagent.logs-rotate (daily 00:05 local gzip archive).
# Does not kickstart: a kickstart would rotate and truncate live logs immediately.
set -euo pipefail

REPO="${YL_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.personalagent.logs-rotate"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# shellcheck source=service-log-dir.sh
source "$REPO/deploy/launchagents/service-log-dir.sh"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$REPO/scripts/rotate-service-logs.sh" ]]; then
  echo "missing or not executable: $REPO/scripts/rotate-service-logs.sh" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"

if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]]; then
  /usr/bin/sed -i '' "s|$HOME/yanylevin_agentic_framework|${REPO}|g" "$DEST"
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

echo "installed ${LABEL}"
echo "logs: $SERVICE_LOG_DIR"
echo "archives: $SERVICE_LOG_ARCHIVE_DIR (daily 00:05 local, gzip, keep forever)"
