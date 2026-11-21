#!/bin/sh
# Resolve every pinned tool without cached layers; remove our container and image.
set -eu
cd "$(dirname "$0")/.."
image="tk-toolchain-check-$(date +%s)-$$"
child=
cleanup() {
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  docker container rm --force "$image" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
run_docker() {
  docker "$@" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_docker build --no-cache --progress plain -t "$image" -f .hack/toolchain/Dockerfile .
run_docker run --rm --init --name "$image" "$image" exec sh -ec \
  'bun --version; node --version; zig version; cargo --version; java -version; java -cp "$TLA2TOOLS_JAR" tlc2.TLC -help >/dev/null'
