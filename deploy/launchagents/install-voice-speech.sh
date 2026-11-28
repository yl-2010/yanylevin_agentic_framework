#!/usr/bin/env bash
# Install the warm Parakeet and Kokoro process on 127.0.0.1:3016.
# Mac Studio only. Weights download only from this script, into
# ~/Library/Application Support/yanylevin/voice-models/.
# Does not restart the Express API.

set -euo pipefail

REPO="${VOICE_REPO:-$HOME/yanylevin_agentic_framework}"
LABEL="com.yanylevin.voice-speech"
SRC="$REPO/deploy/launchagents/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
VENV="${VOICE_VENV:-$HOME/Library/Application Support/yanylevin/voice-speech-venv}"
PY="${VOICE_PYTHON:-/opt/homebrew/bin/python3}"
PORT="${VOICE_SPEECH_PORT:-3016}"

studio=0
if hostname | grep -qi 'Mac-Studio'; then studio=1; fi
if scutil --get ComputerName 2>/dev/null | grep -qi 'Mac Studio'; then studio=1; fi
if [[ "$studio" -ne 1 ]]; then
  echo "voice speech install runs on the Mac Studio only"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "missing plist: $SRC" >&2
  exit 1
fi
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3 || true)"
fi
if [[ ! -x "$PY" ]]; then
  echo "python3 not found" >&2
  exit 1
fi
if ! "$PY" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "voice speech needs Python 3.10 or newer" >&2
  exit 1
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "espeak-ng is not on PATH. Kokoro needs it. brew install espeak-ng" >&2
fi

# shellcheck source=service-log-dir.sh
source "$REPO/deploy/launchagents/service-log-dir.sh"

mkdir -p "$HOME/Library/LaunchAgents"
if [[ ! -x "$VENV/bin/python3" ]]; then
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/python3" -m pip install -U pip
"$VENV/bin/python3" -m pip install -r "$REPO/server/voice-speech-requirements.txt"
"$VENV/bin/python3" "$REPO/server/download-voice-models.py"

cp "$SRC" "$DEST"
DEFAULT_VENV="/Users/you/Library/Application Support/yanylevin/voice-speech-venv"
if [[ "$REPO" != "$HOME/yanylevin_agentic_framework" ]] || [[ "$VENV" != "$DEFAULT_VENV" ]]; then
  /usr/bin/sed -i '' \
    -e "s|$HOME/yanylevin_agentic_framework|${REPO}|g" \
    -e "s|${DEFAULT_VENV}|${VENV}|g" \
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

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -f "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "installed ${LABEL}"
    curl -sS "http://127.0.0.1:${PORT}/health"; echo
    echo "logs: $SERVICE_LOG_DIR/yanylevin-voice-speech.log"
    exit 0
  fi
  sleep 1
done
echo "${LABEL} did not answer /health; see $SERVICE_LOG_DIR/yanylevin-voice-speech.log" >&2
exit 1
