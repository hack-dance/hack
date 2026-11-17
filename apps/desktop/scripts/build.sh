#!/usr/bin/env bash
# Build the desktop app with its terminal panel: provision the pinned
# libghostty-vt inputs (fetches only what is missing, each file checked
# against the sha256 committed in term/scripts/provision-ghostty.sh), then
# `cargo build`. Extra arguments go to cargo, e.g. `bash scripts/build.sh
# --release`. The binary is target/<profile>/hack-desktop.
#
# On macOS the panel is always part of the app; on Linux this turns on the
# `terminal` feature and uses the provisioned Zig.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
# An exported GHOSTTY_RELEASE_DIR is the caller's choice: provision (or
# verify) that directory, never replace it with the default.
dir_args=()
if [[ -n "${GHOSTTY_RELEASE_DIR:-}" ]]; then
  dir_args=(--dir "$GHOSTTY_RELEASE_DIR")
fi
if ! provisioned=$(bash term/scripts/provision-ghostty.sh "${dir_args[@]}"); then
  echo "build: could not provision the libghostty-vt inputs (see above); nothing was built." >&2
  exit 1
fi
eval "$provisioned"
exec cargo build --locked -p hack-desktop --features terminal "$@"
