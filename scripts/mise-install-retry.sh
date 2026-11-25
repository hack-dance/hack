#!/bin/sh
# Run `mise install [TOOL...]` with a longer HTTP timeout and a bounded
# number of attempts. mise downloads Zig from a random community mirror and
# checks its minisign signature (and checksums for other tools); a mirror
# that does not answer within MISE_HTTP_TIMEOUT fails the whole install, and
# another attempt picks another mirror. Verification is mise's own and is
# never turned off here.
#
#   sh scripts/mise-install-retry.sh zig        # one tool
#   sh scripts/mise-install-retry.sh            # everything in mise.toml
#
# MISE_HTTP_TIMEOUT (default 90s) and MISE_INSTALL_ATTEMPTS (default 4) may
# be set by the caller; MISE_INSTALL_RETRY_DELAY (default 15) is the base of
# the linear backoff between attempts, in seconds. POSIX sh, so the
# contributor toolchain image can run it.
set -eu

MISE_HTTP_TIMEOUT=${MISE_HTTP_TIMEOUT:-90s}
export MISE_HTTP_TIMEOUT
attempts=${MISE_INSTALL_ATTEMPTS:-4}
delay=${MISE_INSTALL_RETRY_DELAY:-15}

attempt=1
while :; do
  if mise install "$@"; then
    exit 0
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "mise-install-retry: mise install $* failed $attempt times" >&2
    exit 1
  fi
  wait_seconds=$((attempt * delay))
  echo "mise-install-retry: mise install $* failed (attempt $attempt of $attempts); retrying in ${wait_seconds}s" >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
