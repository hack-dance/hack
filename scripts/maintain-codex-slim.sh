#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(pwd)}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "${HOME}/.local/share/mise/shims" ]; then
  export PATH="${HOME}/.local/share/mise/shims:${PATH}"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required before running scripts/maintain-codex-slim.sh" >&2
  exit 1
fi

repo_root="$(cd "${repo_root}" && pwd)"

cd "${repo_root}"
bun install --frozen-lockfile || bun install
"${script_dir}/install-codex-slim.sh" "${repo_root}"
