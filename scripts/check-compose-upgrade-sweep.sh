#!/usr/bin/env bash
# Run from the repository root after building the CLI under test.
set -euo pipefail

case "$#:${1-}" in
  0:) trials=10 ;;
  1:--trial) trials=1 ;;
  *) echo 'Usage: check-compose-upgrade-sweep.sh [--trial]' >&2; exit 2 ;;
esac

export HACK_E2E_CLI_BIN="${HACK_E2E_CLI_BIN:-$PWD/dist/hack}"
export HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_REQUIRE_TMUX=1

test -x "$HACK_E2E_CLI_BIN"
command -v tmux >/dev/null
docker info >/dev/null
docker image inspect alpine:3.20 >/dev/null
source_revision=$(git rev-parse --verify HEAD)
printf 'source=%s\n' "$source_revision"
if command -v sha256sum >/dev/null; then
  sha256sum "$HACK_E2E_CLI_BIN"
else
  shasum -a 256 "$HACK_E2E_CLI_BIN"
fi

# Each invocation has a fresh fixture home and checks three SIGINT modes.
for ((trial = 1; trial <= trials; trial++)); do
  printf '\nCompose trial %d/%d\n' "$trial" "$trials"
  bun tests/e2e/run.ts --only=compose-foreground-signal
done

bun tests/e2e/run.ts --only=mcp-logs-compose
signals=$((trials * 3))
printf '\nCompose SIGINT: %d/%d. MCP SDK Compose logs: passed.\n' "$signals" "$signals"
