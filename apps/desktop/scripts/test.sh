#!/usr/bin/env bash
# Separate test processes prevent shared libtest fork/write/descriptor races.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
cd "$root/apps/desktop"
version=$(bash "$root/scripts/install-cargo-nextest.sh" --print-version)
actual=$(cargo nextest --version 2>/dev/null) || actual=""
case "$actual" in
  "cargo-nextest $version"|"cargo-nextest $version ("*) ;;
  *) echo "Install pinned cargo-nextest: bash scripts/install-cargo-nextest.sh DESTINATION; add DESTINATION to PATH" >&2; exit 2 ;;
esac
repetitions=${HACK_DESKTOP_TEST_REPETITIONS:-1}
case "$repetitions" in 1|200) ;; *) echo 'HACK_DESKTOP_TEST_REPETITIONS must be 1 or 200.' >&2; exit 2 ;; esac
# Cargo keeps using its configured cache/toolchain; test children get private
# HOME/HACK_HOME. The directory is created by this invocation and removed on exit.
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
owned=$(mktemp -d "${TMPDIR:-/tmp}/hack-desktop-tests.XXXXXXXX")
trap 'rm -rf -- "$owned"' EXIT
mkdir "$owned/home" "$owned/hack"
export HOME="$owned/home" HACK_HOME="$owned/hack"
export HACK_DAEMON_AUTOSTART_DISABLE=1
for ((attempt = 1; attempt <= repetitions; attempt++)); do
  echo "Desktop workspace suite $attempt/$repetitions (no retries)"
  cargo nextest run --locked --workspace --build-jobs 2 --config-file "$root/.config/nextest.toml" --profile ci "$@"
done
cargo test --locked --workspace --doc --jobs 2
