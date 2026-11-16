#!/usr/bin/env bash
# Read-only collision gate, NOT a full isolation check or qualification runner.
# Usage: bash scripts/linux-isolated-home-preflight.sh BUILT_HACK ABSOLUTE_NEW_HACK_HOME ABSOLUTE_SCRATCH_ROOT
set -euo pipefail
binary=${1:?built hack path required}
isolated_home=${2:?absolute new HACK_HOME required}
scratch_root=${3:?absolute scratch root required}
case "$scratch_root" in
  /*) ;;
  *) echo 'REFUSED: scratch root must be absolute' >&2; exit 2 ;;
esac
case "$isolated_home" in
  /*) ;;
  *) echo 'REFUSED: home must be absolute' >&2; exit 2 ;;
esac
# Canonicalize missing paths too, so root/../outside cannot pass containment.
scratch_root=$(realpath -m -- "$scratch_root")
isolated_home=$(realpath -m -- "$isolated_home")
case "$isolated_home" in
  "$scratch_root"/*) ;;
  *) echo 'REFUSED: home must be under the assigned scratch root' >&2; exit 2 ;;
esac
if [[ -e "$isolated_home" ]]; then
  echo 'REFUSED: expected a new isolated home' >&2; exit 2
fi
unset HACK_SYSTEMD_ALLOW_ISOLATED_HOME HACK_LAUNCHD_ALLOW_ISOLATED_HOME
export HACK_HOME="$isolated_home" HACK_SYSTEMD_DISABLE=1 HACK_DAEMON_AUTOSTART_DISABLE=1 HACK_NO_INTERACTIVE=1
"$binary" --version
for project in hack-dev-proxy hack-logging; do
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  if [[ -n "$ids" ]]; then
    ids=${ids//$'\n'/ }
    printf 'BLOCKED: shared Compose project %s already exists: %s\n' "$project" "$ids" >&2
    echo 'HACK_HOME and proxy.bind_address do not isolate Compose identity, networks or volumes.' >&2
    exit 3
  fi
done
if docker network inspect hack-dev >/dev/null 2>&1; then
  echo 'BLOCKED: shared hack-dev network exists; ownership is not established' >&2; exit 3
fi
echo 'No matching proxy/logging projects or hack-dev network found. Other networks, volumes, remote routes and ports were NOT checked. This is NOT authorization to install; full isolation requires a reviewed procedure.'
exit 4
