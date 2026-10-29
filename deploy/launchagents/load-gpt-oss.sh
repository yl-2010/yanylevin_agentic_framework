#!/usr/bin/env bash
# Open LM Studio at login and load gpt-oss-20b with no idle timeout.
# Does not load or unload Orpheus.
set -u

LMS="${LMS_BIN:-$HOME/.lmstudio/bin/lms}"
MODEL="openai/gpt-oss-20b"
CONTEXT="131072"
PARALLEL="4"

if [[ ! -x "$LMS" ]]; then
  echo "lms not found at $LMS" >&2
  exit 1
fi

lms_up() {
  "$LMS" ps --json >/dev/null 2>&1
}

if ! lms_up; then
  open -g -a "LM Studio" || true
fi

for _ in $(seq 1 60); do
  if lms_up; then
    break
  fi
  sleep 3
done

if ! lms_up; then
  echo "LM Studio did not respond" >&2
  exit 1
fi

if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:1234/v1/models"; then
  "$LMS" server start || true
  for _ in $(seq 1 30); do
    if curl -sf -m 2 -o /dev/null "http://127.0.0.1:1234/v1/models"; then
      break
    fi
    sleep 1
  done
fi

if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:1234/v1/models"; then
  echo "LM Studio server is not on port 1234" >&2
  exit 1
fi

LMS_BIN="$LMS" MODEL="$MODEL" CONTEXT="$CONTEXT" PARALLEL="$PARALLEL" python3 - <<'PY'
import json, os, subprocess, sys

lms = os.environ["LMS_BIN"]
model = os.environ["MODEL"]
raw = subprocess.check_output([lms, "ps", "--json"], text=True)
loaded = json.loads(raw)
if isinstance(loaded, dict):
    loaded = loaded.get("models") or []

for item in loaded:
    ident = item.get("identifier") or item.get("modelKey")
    if ident != model:
        continue
    if item.get("ttlMs") is None:
        print(f"{model} already loaded, leaving it")
        sys.exit(0)
    print(f"{model} has a TTL, reloading without one")
    subprocess.check_call([lms, "unload", model])
    break

subprocess.check_call([
    lms, "load", model,
    "--context-length", os.environ["CONTEXT"],
    "--parallel", os.environ["PARALLEL"],
    "--identifier", model,
    "-y",
])
print(f"loaded {model}")
PY
