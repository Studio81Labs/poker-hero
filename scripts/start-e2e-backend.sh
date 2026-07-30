#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKEND_DIR="$ROOT_DIR/apps/backend"
DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/poker-hero-e2e.XXXXXX")
SERVER_PID=""

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$DATA_DIR"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if [ -n "${POKER_E2E_PYTHON:-}" ]; then
  PYTHON_BIN=$POKER_E2E_PYTHON
elif [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$BACKEND_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=$(command -v python3)
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=$(command -v python)
else
  echo "Python 3.11+ with Poker Hero backend dependencies is required" >&2
  exit 1
fi

cd "$BACKEND_DIR"
POKER_DATA_DIR="$DATA_DIR" \
POKER_PARSER_PROVIDER=mock \
POKER_RECOMMENDATION_PROVIDER=mock \
POKER_CORS_ORIGINS='["http://127.0.0.1:4174"]' \
  "$PYTHON_BIN" -m uvicorn app.main:app \
    --host 127.0.0.1 \
    --port 8010 &
SERVER_PID=$!
wait "$SERVER_PID"
