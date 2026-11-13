#!/usr/bin/env bash
# Install / reload com.personalagent.agent-worker (Personal Agent worker on 127.0.0.1:3005).
# Mac Studio only. The API (com.personalagent.server) proxies agent routes to it.
#
# Reloading this job kills in-flight agent turns. Run it only when
# server/personal-agent.js (or what it imports) changed, or on first install.

set -euo pipefail

REPO="${WORKER_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.personalagent.agent-worker"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${WORKER_NODE:-/opt/homebrew/bin/node}"
PORT="${AGENT_WORKER_PORT:-3005}"

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found at $NODE_BIN (set WORKER_NODE)" >&2
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
  # bootout+bootstrap so StandardOutPath and other plist edits take effect.
  # kickstart alone keeps the old loaded configuration.
  launchctl bootout "$SERVICE" 2>/dev/null || launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
  sleep 1
else
  # The API spawns a detached worker when no LaunchAgent exists. Stop that
  # one so the LaunchAgent can bind the port.
  for pid in $(/usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    if ps -o command= -p "$pid" | grep -q 'agent-worker.js'; then
      echo "stopping detached worker pid $pid"
      kill "$pid" || true
    fi
  done
  sleep 1
fi
yl_bootstrap_agent "$DOMAIN" "$DEST"
launchctl enable "$SERVICE" 2>/dev/null || true
launchctl kickstart -k "$SERVICE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -f "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "installed ${LABEL}"
    curl -sS "http://127.0.0.1:${PORT}/health"; echo
    echo "logs: $SERVICE_LOG_DIR/personal-agent-worker.log"
    exit 0
  fi
  sleep 1
done
echo "${LABEL} did not answer /health; see $SERVICE_LOG_DIR/personal-agent-worker.log" >&2
exit 1
