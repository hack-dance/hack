#!/bin/sh
# Sign in to the edge platform CLI and write its token to a private file that
# Compose mounts as a secret. Replace the edgectl commands with your CLI's.
set -eu

if ! edgectl whoami >/dev/null 2>&1; then
  edgectl login
fi

umask 077
mkdir -p .credentials
edgectl token > .credentials/edge-token.tmp
mv .credentials/edge-token.tmp .credentials/edge-token
