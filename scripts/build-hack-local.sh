#!/bin/sh
# Build only this checkout's candidate. No installer, shell profile or v4 binary is touched.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ -L "$repo/.hack-local" ] || [ -L "$repo/.hack-local/target" ] || \
   [ -L "$repo/.hack-local/target/release" ] || \
   [ -L "$repo/.hack-local/target/release/hack-runtime-candidate" ]; then
  echo "build-hack-local: refusing aliased candidate build/state directories." >&2
  exit 2
fi
umask 077
cd "$repo"
exec cargo build --locked --release --jobs 2 --features native-http-probe \
  --manifest-path "$repo/packages/runtime-core/Cargo.toml" \
  --target-dir "$repo/.hack-local/target"
