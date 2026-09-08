#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v bun >/dev/null || {
  echo "bun is required for this mission" >&2
  exit 1
}

mkdir -p .factory/validation .factory/library .factory/research

bun install --frozen-lockfile
bun run build
