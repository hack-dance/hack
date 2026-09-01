#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_tag="${1:-hack-runtime-ci:slim}"
platform="${2:-linux/amd64}"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to prepare the portable container smoke fixture" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the portable container smoke" >&2
  exit 1
fi

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/hack-portable-container-XXXXXX")"
cleanup() {
  rm -rf "${fixture_root}"
}
trap cleanup EXIT

fixture_project="${fixture_root}/project"
mkdir -p "${fixture_project}"
cp -R "${repo_root}/examples/basic/." "${fixture_project}/"

bun "${repo_root}/index.ts" env add \
  --path "${fixture_project}" \
  PORTABLE_PLAIN "portable-ready"
bun "${repo_root}/index.ts" env add \
  --path "${fixture_project}" \
  --secret \
  PORTABLE_SECRET "portable-secret"

secret_key="$(tr -d '\n' < "${fixture_project}/.hack.secret.key")"
rm -f "${fixture_project}/.hack.secret.key"

docker run \
  --rm \
  --platform "${platform}" \
  -e HACK_ENV_SECRET_KEY="${secret_key}" \
  -v "${fixture_project}:/workspace/project" \
  --workdir /workspace/project \
  --entrypoint sh \
  "${image_tag}" \
  -lc '
    set -euo pipefail
    test ! -f .hack.secret.key
    hack env list --json --show-secrets > /tmp/hack-env.json
    grep -q "\"PORTABLE_PLAIN\"" /tmp/hack-env.json
    grep -q "\"portable-ready\"" /tmp/hack-env.json
    grep -q "\"PORTABLE_SECRET\"" /tmp/hack-env.json
    grep -q "\"portable-secret\"" /tmp/hack-env.json
    test "$(hack host exec -- printenv PORTABLE_PLAIN)" = "portable-ready"
    test "$(hack host exec -- printenv PORTABLE_SECRET)" = "portable-secret"
  '

echo "portable container smoke passed for ${image_tag} (${platform})"
