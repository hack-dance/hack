#!/bin/sh
# Explicit candidate bundle only: never modifies the installed hack, shell, or runtime state.
set -eu
umask 077
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/build-native-candidate.sh /absolute/new/bundle-directory" >&2
  exit 64
fi
case "$1" in /*) ;; *) echo "Output must be an absolute new directory" >&2; exit 64 ;; esac
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "Native candidate bundle currently supports Apple Silicon macOS only" >&2
  exit 69
fi
if [ -e "$1" ] || [ -L "$1" ]; then
  echo "Refusing to replace an existing output path" >&2
  exit 73
fi
parent=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd -P)
out="$parent/$(basename -- "$1")"
cd "$repo"
case "$(rustc --version)" in "rustc 1.97.1 "*) ;; *) echo "Pinned Rust 1.97.1 is required" >&2; exit 69 ;; esac
if [ "$(zig version)" != 0.15.2 ]; then
  echo "Pinned Zig 0.15.2 is required" >&2
  exit 69
fi
command -v python3 >/dev/null
stdlib=$(rustc --print target-libdir --target aarch64-unknown-linux-musl)
set -- "$stdlib"/libstd-*.rlib
if [ ! -f "$1" ]; then
  echo "Install the pinned Rust toolchain's aarch64-unknown-linux-musl standard library before building" >&2
  exit 69
fi
for path in .hack-local .hack-local/native-candidate-target .hack-local/native-candidate-target/release .hack-local/native-candidate-target/release/hack-native .hack-local/native-guest-target .hack-local/native-guest-target/aarch64-unknown-linux-musl .hack-local/native-guest-target/aarch64-unknown-linux-musl/release .hack-local/native-guest-target/aarch64-unknown-linux-musl/release/hack-relay-guest; do
  if [ -L "$path" ]; then
    echo "Refusing aliased candidate build directories" >&2
    exit 73
  fi
done
# The isolated target directory also keeps the checkout-bound development build intact.
cargo build --locked --release --jobs 2 --bin hack-native \
  --features installed-candidate,native-http-probe,native-stream-relay,environment-launcher \
  --manifest-path packages/runtime-core/Cargo.toml \
  --target-dir .hack-local/native-candidate-target
CARGO_INCREMENTAL=0 \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C link-self-contained=no' \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$repo/scripts/zig-aarch64-musl-linker" \
cargo build --locked --release --jobs 2 --bin hack-relay-guest \
  --manifest-path packages/relay-guest/Cargo.toml \
  --target aarch64-unknown-linux-musl \
  --target-dir .hack-local/native-guest-target
guest=.hack-local/native-guest-target/aarch64-unknown-linux-musl/release/hack-relay-guest
python3 scripts/verify-native-relay.py "$guest"
# Exclusive mkdir refuses races; an interrupted bundle is retained for inspection.
mkdir -m 700 "$out"
cp .hack-local/native-candidate-target/release/hack-native "$out/hack-native"
cp "$guest" "$out/hack-relay-guest"
chmod 755 "$out/hack-native" "$out/hack-relay-guest"
python3 scripts/verify-native-relay.py "$out/hack-relay-guest"
cp packages/runtime-core/provider-pins.json "$out/provider-pins.json"
cp docs/guides/native-candidate.md "$out/README.md"
(
  cd "$out"
  shasum -a 256 hack-native hack-relay-guest provider-pins.json README.md > SHA256SUMS
)
echo "Candidate bundle: $out"
echo "Verify SHA256SUMS before copying. Create a separate mode-0700 candidate home."
echo "Run: $out/hack-native --candidate-root /absolute/private/candidate-home info --json"
