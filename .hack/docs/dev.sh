#!/bin/bash
set -eu

bun install --cwd site --frozen-lockfile
bun scripts/docs/prepare.ts

# Next watches the staged MDX. Restage it when an editorial source changes.
inotifywait --monitor --recursive --quiet --format '%e' \
  --event close_write,delete,moved_to,moved_from docs/versions scripts/docs site/lib/diagrams |
  while IFS= read -r event; do
    # A checkout or editor save can emit several events for one logical edit.
    while IFS= read -r -t 0.2 event; do :; done
    bun scripts/docs/prepare.ts || echo "Could not stage docs after a source change" >&2
  done &

cd site
exec ./node_modules/.bin/next dev --hostname 0.0.0.0
