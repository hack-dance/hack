#!/usr/bin/env bash
# Build, lint and test hack-desktop-term with the `ghostty` feature, using
# only local inputs: cargo runs with --offline, and libghostty-vt comes from
# the directory provision-ghostty.sh filled (GHOSTTY_RELEASE_DIR, and ZIG on
# Linux). Run it through no-network.sh to prove nothing reaches the network.
#
#   eval "$(bash term/scripts/provision-ghostty.sh)"
#   cargo fetch --locked
#   bash term/scripts/no-network.sh bash term/scripts/check-ghostty.sh
#
# Arguments after `--` go to nextest, for example
#   bash term/scripts/check-ghostty.sh -- --no-fail-fast
set -euo pipefail
nextest_args=()
if [ "${1:-}" = "--" ]; then
  shift
  nextest_args=("$@")
elif [ "$#" -gt 0 ]; then
  echo "usage: check-ghostty.sh [-- <nextest arguments>]" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd -P)
cd "$root/apps/desktop"
: "${GHOSTTY_RELEASE_DIR:?run term/scripts/provision-ghostty.sh and export what it prints}"
export CARGO_NET_OFFLINE=true HACK_DAEMON_AUTOSTART_DISABLE=1
# Children of the tests get their own environment; this keeps the test
# binaries themselves away from the caller's home.
owned=$(mktemp -d "${TMPDIR:-/tmp}/hack-desktop-term-check.XXXXXXXX")
trap 'rm -rf -- "$owned"' EXIT
mkdir "$owned/home" "$owned/hack"
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo} RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
export HOME="$owned/home" HACK_HOME="$owned/hack"

cargo build --locked --offline -p hack-desktop-term --features ghostty --all-targets
cargo clippy --locked --offline -p hack-desktop-term --all-targets --features ghostty -- -D warnings
cargo clippy --locked --offline -p hack-desktop-term --all-targets --features screenshots -- -D warnings
# The `screenshots` feature adds GPUI's test support, which the headless
# view tests need. They open no window and need no display or GPU.
cargo nextest run --locked --offline -p hack-desktop-term --features screenshots \
  --build-jobs 2 --config-file "$root/.config/nextest.toml" --profile ci \
  ${nextest_args[@]+"${nextest_args[@]}"}
cargo test --locked --offline -p hack-desktop-term --features screenshots --doc --jobs 2
