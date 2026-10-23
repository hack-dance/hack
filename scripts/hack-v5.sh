#!/bin/sh
# Relocatable frontend for an explicitly selected candidate bundle.
#
# Backend selection: an unset or empty HACK_RUNTIME_BACKEND selects the native
# runtime with this bundle's adjacent executor and the explicit private
# HACK_NATIVE_HOME. An explicit HACK_RUNTIME_BACKEND=compose runs this bundle's
# CLI on the Compose backend with the caller's own Hack home (HACK_HOME, or
# ~/.hack when unset); native selectors are removed so they cannot leak into
# Compose children. Any other value refuses rather than guessing.
set -eu
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
backend=${HACK_RUNTIME_BACKEND:-native}
case "$backend" in
  native|compose) ;;
  *) echo "HACK_RUNTIME_BACKEND must be native or compose (unset selects native)." >&2; exit 64 ;;
esac
if [ "$backend" = native ]; then
  case "${HACK_NATIVE_HOME:-}" in
    /*) ;;
    *) echo "Set HACK_NATIVE_HOME to an existing private candidate home (absolute path)." >&2; exit 64 ;;
  esac
fi
if [ ! -x "$bundle/hack-cli" ] || [ ! -x "$bundle/hack-native" ]; then
  echo "Incomplete candidate bundle: hack-cli and hack-native are required." >&2
  exit 69
fi
# Candidate CLIs refuse self-update on either backend.
export HACK_CANDIDATE_ENTRYPOINT=hack-v5
# Candidate runs never start hackd implicitly: autostart would start the
# stable hackd (launchd plist or the `hack` on PATH), on Compose beside the
# candidate on the same Hack home (HACK-1368).
export HACK_DAEMON_AUTOSTART_DISABLE=1
if [ "$backend" = native ]; then
  export HACK_RUNTIME_BACKEND=native
  export HACK_NATIVE_BINARY="$bundle/hack-native"
else
  unset HACK_NATIVE_BINARY HACK_NATIVE_HOME
  export HACK_RUNTIME_BACKEND=compose
fi
exec "$bundle/hack-cli" "$@"
