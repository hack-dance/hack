#!/usr/bin/env bash
# Cloud Agent install: idempotent bootstrap for the hack CLI monorepo.
# Installs the pinned Bun toolchain, then installs dependencies and builds
# the CLI binary. Safe to run repeatedly (used to bake the environment build
# baseline; not re-run per boot).
set -euo pipefail

# Keep in sync with package.json "packageManager" and .tool-versions.
BUN_VERSION="1.3.9"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

install_bun() {
  echo "[install] installing bun v${BUN_VERSION}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
}

if ! command -v bun >/dev/null 2>&1; then
  install_bun
elif [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  install_bun
else
  echo "[install] bun v${BUN_VERSION} already present"
fi

# Make bun/bunx resolvable from every shell (including non-login shells that
# do not source ~/.bashrc), so agents and tooling always find the toolchain.
if [ -w /usr/local/bin ] || sudo -n true 2>/dev/null; then
  sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  sudo ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx
fi

cd "$(dirname "$0")/.."

echo "[install] bun install (frozen lockfile)"
bun install --frozen-lockfile

echo "[install] building hack CLI"
bun run build

echo "[install] done: $(bun --version) -> $(./dist/hack --version)"
