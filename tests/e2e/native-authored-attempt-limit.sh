#!/usr/bin/env bash
# Run on macOS with a running isolated pool, a current-branch Hack binary,
# and a disposable authored project with exactly one private environment service.
set -euo pipefail
hack_bin=${1:?Pass the absolute Hack executable}
project=${2:?Pass the disposable authored project}
state=${HACK_NATIVE_HOME:?Select the isolated candidate home}/.hack-local
export HACK_RUNTIME_BACKEND=native
: "${HACK_NATIVE_BINARY:?Select the isolated candidate binary}"

count() {
  if [[ -d "$1" ]]; then
    find "$1" -mindepth 1 -maxdepth 1 -type "$2" | wc -l
  else
    echo 0
  fi
}

active="$state/run/native-graphs"
archived="$state/run/native-graph-archive"
leases="$state/run/native-environment-leases"
[[ $(count "$active" d) -eq 0 && $(count "$archived" d) -eq 0 ]]
[[ $(count "$leases" f) -eq 0 ]]

running=0
cleanup() {
  if ((running)); then "$hack_bin" --path "$project" down >/dev/null; fi
}
trap cleanup EXIT
for ((cycle = 1; cycle <= 64; cycle++)); do
  running=1
  "$hack_bin" --path "$project" up -d >/dev/null
  "$hack_bin" --path "$project" down >/dev/null
  running=0
  [[ $(count "$leases" f) -eq $cycle ]]
done
[[ $(count "$active" d) -eq 64 && $(count "$archived" d) -eq 0 ]]

running=1
if result=$("$hack_bin" --path "$project" up -d --json); then
  echo "Expected the 65th authored start to refuse." >&2
  exit 1
fi
jq -e '.ok == false and .error.code == "E_STARTUP_INCOMPLETE"
  and .error.detail.nativeCode == "native_graph_attempt_limit"
  and (.error.message | contains("64 attempts")
    and contains("private environment records")
    and contains("hack doctor --native-cleanup inspect"))' <<<"$result" >/dev/null
[[ $(count "$active" d) -eq 64 && $(count "$archived" d) -eq 0 ]]
running=0
