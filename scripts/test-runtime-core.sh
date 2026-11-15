#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname -- "$0")/test-rust.sh" --crate=runtime-core "$@"
