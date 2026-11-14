#!/bin/sh
# Build the same guest artifact as build-native-candidate, including shared sources.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repo"
CARGO_INCREMENTAL=0 \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C link-self-contained=no' \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$repo/scripts/zig-aarch64-musl-linker" \
cargo build --locked --release --jobs 2 --bin hack-relay-guest \
  --manifest-path packages/relay-guest/Cargo.toml \
  --target aarch64-unknown-linux-musl \
  --target-dir "${HACK_GUEST_CHECK_TARGET_DIR:-.hack-local/native-guest-target}"
python3 scripts/verify-native-relay.py "${HACK_GUEST_CHECK_TARGET_DIR:-.hack-local/native-guest-target}/aarch64-unknown-linux-musl/release/hack-relay-guest"
