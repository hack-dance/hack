#!/usr/bin/env bash
# Download a pinned Zig tarball into DIR and verify it against SHA256.
# ziglang.org is tried first, then the pinned community mirrors (from a
# random offset, with ?source=hack-ci); each source gets a few resumable
# attempts and the whole download a time budget. Only a file matching
# SHA256 is left at DIR/FILE; any other outcome exits non-zero.
#
#   bash scripts/fetch-zig.sh VERSION FILE SHA256 DIR
#   bash scripts/fetch-zig.sh 0.15.2 zig-x86_64-linux-0.15.2.tar.xz 02aa27... "$RUNNER_TEMP/zig"
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: fetch-zig.sh VERSION FILE SHA256 DIR" >&2
  exit 2
fi
fetch_log=fetch-zig
# shellcheck source-path=SCRIPTDIR source=lib/fetch-verified.sh
source "$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib/fetch-verified.sh"

zig_base="https://ziglang.org/download/$1"
mkdir -p "$4"
dir=$(CDPATH='' cd -- "$4" && pwd -P)
zig_urls "$2"
fetch "$2" "$3" "${zig_sources[@]}"
