#!/usr/bin/env bash
set -euo pipefail

# Official stable release, verified against the release asset SHA-256 metadata.
version=0.9.151
if [[ "${1-}" == --print-version ]]; then
  printf '%s\n' "$version"
  exit 0
fi
if [[ "$#" != 1 ]]; then
  echo 'Usage: bash scripts/install-cargo-nextest.sh DESTINATION' >&2
  exit 2
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    target=x86_64-unknown-linux-gnu
    checksum=1d4ce302b820c41f4b89c5fb9bce45f0f0c94882c1cf08fc360caf08be6e7df4
    ;;
  Darwin-arm64|Darwin-x86_64)
    target=universal-apple-darwin
    checksum=d1d7d025d4bfc9fb154cd76aea3949bd78534829a0589abefa6e5dd4edb135dd
    ;;
  *) echo 'Unsupported nextest release platform.' >&2; exit 2 ;;
esac
archive="cargo-nextest-${version}-${target}.tar.gz"
destination=$1
mkdir -p "$destination"
curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 \
  "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-${version}/${archive}" \
  -o "$destination/$archive"
if command -v shasum >/dev/null 2>&1; then
  (cd "$destination" && printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check)
else
  (cd "$destination" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check)
fi
tar -xzf "$destination/$archive" -C "$destination" cargo-nextest
"$destination/cargo-nextest" --version
