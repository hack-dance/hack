#!/bin/sh
# Resolve every pinned tool from an empty image cache; remove only our image.
set -eu
cd "$(dirname "$0")/.."
image="tk-toolchain-check-$(date +%s)-$$"
cleanup() {
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --no-cache --progress plain -t "$image" -f .hack/toolchain/Dockerfile .
docker run --rm --init --name "$image" "$image" exec sh -ec \
  'bun --version; node --version; zig version; cargo --version; java -version; test -s "$TLA2TOOLS_JAR"'
