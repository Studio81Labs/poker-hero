#!/bin/sh
set -eu

DATA_DIR="${POKER_DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR"
chown -R poker:poker "$DATA_DIR"

exec gosu poker "$@"
