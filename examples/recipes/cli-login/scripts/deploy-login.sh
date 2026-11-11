#!/bin/sh
# Sign in to the deploy platform CLI and keep its token in Hack's managed env.
# Replace the three deployctl commands with your CLI's sign-in, status and
# token commands.
set -eu

if ! deployctl whoami >/dev/null 2>&1; then
  deployctl login
fi
token=$(deployctl token)

# Hack resolves service env before this hook runs, so a value written now only
# reaches containers on the next start. Stop this start when the token changed,
# so no service runs with the old one.
stored=$(hack env get DEPLOY_TOKEN --service app 2>/dev/null || true)
if [ "$token" != "$stored" ]; then
  printf '%s' "$token" | hack env add DEPLOY_TOKEN --service app --secret --local --value-stdin
  echo "deploy-login: stored a new DEPLOY_TOKEN. Run hack up again." >&2
  exit 1
fi
