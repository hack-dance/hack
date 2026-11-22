#!/bin/sh
# Run from the repository root after bun run build, as an unprivileged contributor.
set -eu

if [ "$(id -u)" = 0 ]; then
  echo "Run this check as a non-root user to exercise checkout ownership." >&2
  exit 1
fi

root=$(git rev-parse --show-toplevel)
cli=$root/dist/hack
bun_bin=$(bun -p 'process.execPath')
fixture=$(mktemp -d)
instance="deps-check-$$"
git clone --quiet --no-local --depth 1 "$root" "$fixture/checkout"
mkdir "$fixture/profile"
export HOME="$fixture/profile" XDG_CONFIG_HOME="$fixture/profile/config"
export XDG_CACHE_HOME="$fixture/profile/cache" XDG_DATA_HOME="$fixture/profile/data"
export XDG_STATE_HOME="$fixture/profile/state"
export HACK_DAEMON_AUTOSTART_DISABLE=1 HACK_NO_INTERACTIVE=1
export HACK_DEPS_USER="$(id -u):$(id -g)"
cd "$fixture/checkout"
cleanup() {
  "$cli" down --branch "$instance" >/dev/null || return 1
  cd "$root"
  rm -rf "$fixture"
}
trap cleanup EXIT
"$cli" run --branch "$instance" --profile deps deps
owned=$(find . -user root -print -quit)
if [ -n "$owned" ]; then
  echo "Dependency installation left a root-owned checkout path: $owned" >&2
  exit 1
fi
"$bun_bin" index.ts down --branch "$instance"
echo "No root-owned checkout paths; source CLI down passed."
