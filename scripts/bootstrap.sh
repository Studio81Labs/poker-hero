#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKEND_DIR="$ROOT_DIR/apps/backend"

command -v node >/dev/null 2>&1 || { echo "Node.js 24+ is required" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm 10+ is required" >&2; exit 1; }

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "Python 3.11+ is required" >&2
  exit 1
fi

pnpm install --frozen-lockfile

if [ ! -d "$BACKEND_DIR/.venv" ]; then
  "$PYTHON_BIN" -m venv "$BACKEND_DIR/.venv"
fi

"$BACKEND_DIR/.venv/bin/python" -m pip install --upgrade pip
"$BACKEND_DIR/.venv/bin/python" -m pip install -e "$BACKEND_DIR[dev]"

if [ ! -f "$BACKEND_DIR/.env" ]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi

echo "Poker Hero is ready."
echo "Run 'pnpm backend:dev' and 'pnpm frontend:dev' in separate terminals."
