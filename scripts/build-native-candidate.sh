#!/bin/sh
# Explicit candidate bundle only: never modifies the installed hack, shell, or runtime state.
set -eu
umask 077
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: scripts/build-native-candidate.sh /absolute/new/bundle-directory [--version=5.0.0-next.N]" >&2
  exit 64
fi
version=
metadata=
if [ "$#" -eq 2 ]; then
  case "$2" in --version=*) version=${2#--version=} ;; *) echo "Unknown build option" >&2; exit 64 ;; esac
  source_revision=$(git -C "$repo" rev-parse HEAD)
  metadata=$(HACK_PRERELEASE_VERSION="$version" HACK_PRERELEASE_SOURCE_REVISION="$source_revision" bun "$repo/scripts/prerelease-plan.ts" metadata)
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=normal)" ]; then
    echo "Versioned prereleases require a clean source checkout" >&2
    exit 73
  fi
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
if [ "$(bun --version)" != 1.4.2 ]; then
  echo "Pinned Bun 1.4.2 is required" >&2
  exit 69
fi
stdlib=$(rustc --print target-libdir --target aarch64-unknown-linux-musl)
set -- "$stdlib"/libstd-*.rlib
if [ ! -f "$1" ]; then
  echo "Install the pinned Rust toolchain's aarch64-unknown-linux-musl standard library before building" >&2
  exit 69
fi
for path in .hack-local .hack-local/native-candidate-target .hack-local/native-candidate-target/release .hack-local/native-candidate-target/release/hack-native .hack-local/native-candidate-target/release/hack-mcp-adapter .hack-local/native-candidate-target/release/hack-mcp-owner .hack-local/native-candidate-target/release/hack-mcp-backend .hack-local/native-guest-target .hack-local/native-guest-target/aarch64-unknown-linux-musl .hack-local/native-guest-target/aarch64-unknown-linux-musl/release .hack-local/native-guest-target/aarch64-unknown-linux-musl/release/hack-relay-guest; do
  if [ -L "$path" ]; then
    echo "Refusing aliased candidate build directories" >&2
    exit 73
  fi
done
# The isolated target directory also keeps the checkout-bound development build intact.
cargo build --locked --release --jobs 2 --bin hack-native --bin hack-mcp-adapter --bin hack-mcp-owner \
  --features installed-candidate,native-http-probe,native-stream-relay,environment-launcher,shared-mcp \
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
if [ -n "$version" ]; then
  bun build index.ts --compile --define "__HACK_BUILD_VERSION__=\"$version\"" --outfile "$out/hack-cli"
else
  bun build index.ts --compile --outfile "$out/hack-cli"
fi
bun scripts/build-config-compiler.ts
cp dist/hack-config-compiler "$out/hack-config-compiler"
cp packages/config-compiler/generated/hack.project.schema.json "$out/hack.project.schema.json"
chmod 755 "$out/hack-config-compiler"
chmod 600 "$out/hack.project.schema.json"
/usr/bin/codesign --force --sign - --preserve-metadata=entitlements,flags,runtime "$out/hack-config-compiler"
/usr/bin/codesign --verify --strict "$out/hack-config-compiler"
# Bun appends the compiled program to its runtime. Re-sign those final bytes;
# preserve runtime metadata rather than trusting the embedded runtime's signature.
/usr/bin/codesign --force --sign - --preserve-metadata=entitlements,flags,runtime "$out/hack-cli"
/usr/bin/codesign --verify --strict "$out/hack-cli"
/usr/bin/codesign --verify --strict "$out/hack-native"
bun build scripts/run-mcp-socket-backend.ts --compile --outfile .hack-local/native-candidate-target/release/hack-mcp-backend
/usr/bin/codesign --force --sign - --preserve-metadata=entitlements,flags,runtime .hack-local/native-candidate-target/release/hack-mcp-backend
for artifact in hack-mcp-adapter hack-mcp-owner hack-mcp-backend; do
  /usr/bin/codesign --verify --strict ".hack-local/native-candidate-target/release/$artifact"
done
bun scripts/package-mcp-bundle.ts --output "$out/mcp" \
  --adapter .hack-local/native-candidate-target/release/hack-mcp-adapter \
  --owner .hack-local/native-candidate-target/release/hack-mcp-owner \
  --backend .hack-local/native-candidate-target/release/hack-mcp-backend >/dev/null
cp scripts/hack-v5.sh "$out/hack-v5"
chmod 755 "$out/hack-cli" "$out/hack-v5"
cp docs/guides/native-candidate.md "$out/README.md"
if [ -n "$version" ]; then
  printf '%s\n' "$metadata" > "$out/prerelease.json"
  if [ "$("$out/hack-cli" --version)" != "hack v$version" ]; then
    echo "Compiled CLI did not report the prerelease version" >&2
    exit 65
  fi
fi
(
  cd "$out"
  if [ -n "$version" ]; then
    shasum -a 256 hack-native hack-relay-guest hack-cli hack-v5 provider-pins.json README.md prerelease.json > SHA256SUMS
  else
    shasum -a 256 hack-native hack-relay-guest hack-cli hack-v5 provider-pins.json README.md > SHA256SUMS
  fi
  shasum -a 256 hack-config-compiler hack.project.schema.json >> SHA256SUMS
  shasum -a 256 mcp/*/manifest.json mcp/*/hack-mcp-adapter mcp/*/hack-mcp-owner mcp/*/hack-mcp-backend >> SHA256SUMS
)
echo "Candidate bundle: $out"
echo "Verify SHA256SUMS before copying. Create a separate mode-0700 candidate home."
echo "Run: $out/hack-native --candidate-root /absolute/private/candidate-home info --json"
