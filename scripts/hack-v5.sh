#!/bin/sh
# Relocatable frontend for an explicitly selected native candidate home.
set -eu
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
case "${HACK_NATIVE_HOME:-}" in
  /*) ;;
  *) echo "Set HACK_NATIVE_HOME to an existing private candidate home (absolute path)." >&2; exit 64 ;;
esac
if [ ! -x "$bundle/hack-cli" ] || [ ! -x "$bundle/hack-native" ]; then
  echo "Incomplete candidate bundle: hack-cli and hack-native are required." >&2
  exit 69
fi
export HACK_RUNTIME_BACKEND=native
export HACK_NATIVE_BINARY="$bundle/hack-native"
exec "$bundle/hack-cli" "$@"
