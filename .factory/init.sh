#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v bun >/dev/null || {
  echo "bun is required for this mission" >&2
  exit 1
}

command -v hack >/dev/null || {
  echo "hack is required for this mission" >&2
  exit 1
}

mkdir -p .factory/validation .factory/library .factory/research

if [ ! -d node_modules ]; then
  bun install
fi

if [ ! -x dist/hack ]; then
  bun run build
fi
