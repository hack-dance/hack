#!/usr/bin/env bash
# TEMPORARY X03 measurement; reverted before the final commit.
# Decomposes one engine-ID fence on the hosted engine. Prints timings only.
set -euo pipefail
host="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
socket="${host#unix://}"
n=40
bench() {
  local label="$1"
  shift
  local start end
  start=$(date +%s%N)
  for _ in $(seq "$n"); do
    "$@" >/dev/null
  done
  end=$(date +%s%N)
  echo "x03-bench ${label}: $(((end - start) / n / 1000)) us/call over ${n}"
}
echo "x03-bench selection: $(case "$host" in unix://*) echo unix ;; *) echo other ;; esac), DOCKER_HOST set: ${DOCKER_HOST:+yes}"
echo "x03-bench client plugins: $(docker info --format '{{len .ClientInfo.Plugins}}')"
bench "docker info --format {{json .ID}}" docker info --format '{{json .ID}}'
bench "docker version --format server" docker version --format '{{.Server.Version}}'
bench "docker volume ls" docker volume ls --format '{{json .Name}}'
bench "docker context inspect (client only)" docker context inspect --format '{{json .Endpoints.docker.Host}}'
bench "curl GET /info (direct Unix)" curl -sf --unix-socket "$socket" http://docker/info
bench "curl GET /_ping (direct Unix)" curl -sf --unix-socket "$socket" http://docker/_ping
sha="$(command -v docker)"
bench "sha256sum docker CLI" sha256sum "$sha"
echo "x03-bench docker CLI size: $(stat -Lc %s "$sha") bytes"
