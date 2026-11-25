#!/bin/sh
# Lint runtime-core for the shipped targets other than the host, without linking:
# Apple Silicon macOS (default and all features) and the ARM64 musl storage tool.
# PR CI runs this on Linux, where macOS-only code otherwise compiles nowhere
# before review. Nothing runs or links a cross-target binary.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repo"
case "$(rustc --version)" in "rustc 1.97.1 "*) ;; *) echo "Pinned Rust 1.97.1 is required" >&2; exit 69 ;; esac
if [ "$(zig version)" != 0.15.2 ]; then
  echo "Pinned Zig 0.15.2 is required" >&2
  exit 69
fi
for target in aarch64-apple-darwin aarch64-unknown-linux-musl; do
  stdlib=$(rustc --print target-libdir --target "$target")
  set -- "$stdlib"/libstd-*.rlib
  if [ ! -f "$1" ]; then
    echo "Install the pinned Rust toolchain's $target standard library before checking" >&2
    exit 69
  fi
done
target_dir=${HACK_CROSS_CHECK_TARGET_DIR:-.hack-local/target}
manifest=packages/runtime-core/Cargo.toml
# A Mac compiles C build-script inputs with its own toolchain; elsewhere Zig
# supplies the macOS headers and a Mach-O archiver. cc-rs and the runtime-core
# build script read only this target's variables.
if [ "$(uname -s)" != Darwin ]; then
  CC_aarch64_apple_darwin="$repo/scripts/zig-aarch64-macos-cc"
  AR_aarch64_apple_darwin="$repo/scripts/zig-ar"
  export CC_aarch64_apple_darwin AR_aarch64_apple_darwin
fi
for features in "" --all-features; do
  echo "Clippy aarch64-apple-darwin ${features:-default features}" >&2
  # shellcheck disable=SC2086 # an empty feature set adds no argument
  cargo clippy --locked --manifest-path "$manifest" --target-dir "$target_dir" \
    --target aarch64-apple-darwin --all-targets $features --jobs 2 -- -D warnings
done
echo "Clippy aarch64-unknown-linux-musl hack-storage-root-witness" >&2
# The same environment as scripts/build-native-candidate.sh.
CC_aarch64_unknown_linux_musl="$repo/scripts/zig-aarch64-musl-linker" \
AR_aarch64_unknown_linux_musl="$repo/scripts/zig-ar" \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C link-self-contained=no' \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$repo/scripts/zig-aarch64-musl-linker" \
cargo clippy --locked --manifest-path "$manifest" --target-dir "$target_dir" \
  --target aarch64-unknown-linux-musl --bin hack-storage-root-witness \
  --features storage-root-witness-tool --jobs 2 -- -D warnings
