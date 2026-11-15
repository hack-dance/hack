#!/bin/sh
# Relocatable frontend for an explicitly selected candidate bundle.
#
# Backend selection: an unset or empty HACK_RUNTIME_BACKEND selects the native
# runtime with this bundle's adjacent executor and the explicit private
# HACK_NATIVE_HOME (default: $HACK_HOME/native-runtime or ~/.hack/native-runtime).
# An explicit HACK_RUNTIME_BACKEND=compose runs this bundle's
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
# An explicit native operation must use the same home as native up, even when
# the surrounding shell selects Compose for ordinary project commands.
for task_argument in "$@"; do
  case "$task_argument" in
    --no-interactive) continue ;;
    native) backend=native ;;
  esac
  break
done
if [ "$backend" = native ]; then
  trim_path() {
    path_value=$1
    path_value=${path_value#"${path_value%%[![:space:]]*}"}
    path_value=${path_value%"${path_value##*[![:space:]]}"}
    printf '%s' "$path_value"
  }
  native_home=$(trim_path "${HACK_NATIVE_HOME:-}")
  if [ -z "$native_home" ]; then
    hack_home=$(trim_path "${HACK_HOME:-}")
    if [ -z "$hack_home" ]; then
      user_home=$(trim_path "${HOME:-}")
      case "$user_home" in
        /*) hack_home="$user_home/.hack" ;;
        *) echo "Native runtime needs an absolute HOME, HACK_HOME or HACK_NATIVE_HOME." >&2; exit 64 ;;
      esac
    fi
    case "$hack_home" in
      /*) native_home="$hack_home/native-runtime" ;;
      *) echo "HACK_HOME must be an absolute path." >&2; exit 64 ;;
    esac
  fi
  case "$native_home" in
    /*) ;;
    *) echo "HACK_NATIVE_HOME must be an absolute path." >&2; exit 64 ;;
  esac
  export HACK_NATIVE_HOME="$native_home"
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
