#!/bin/sh
# Refuse to start against the production database unless the person running
# hack up says so for this one command.
set -eu
if [ "${DB_TARGET:-local}" = "production" ] && [ "${ALLOW_PRODUCTION_DB:-}" != "yes" ]; then
  echo "guard: this overlay points at the production database (read-only)." >&2
  echo "guard: run ALLOW_PRODUCTION_DB=yes hack up --env production to continue." >&2
  exit 1
fi
