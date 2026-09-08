#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(pwd)}"
bin_dir="${HACK_CODEX_BIN_DIR:-${HOME}/.local/bin}"
assets_dir="${HACK_ASSETS_DIR:-${HOME}/.hack/assets}"
mode="${HACK_EXECUTION_MODE:-codex}"

if [ -d "${HOME}/.local/share/mise/shims" ]; then
  export PATH="${HOME}/.local/share/mise/shims:${PATH}"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required before running scripts/install-codex-slim.sh" >&2
  exit 1
fi

if [ ! -f "${repo_root}/index.ts" ]; then
  echo "Expected a hack repo root containing index.ts: ${repo_root}" >&2
  exit 1
fi

repo_root="$(cd "${repo_root}" && pwd)"
bun_bin="$(command -v bun)"
wrapper_path="${bin_dir}/hack"

mkdir -p "${bin_dir}" "${assets_dir}" "${HOME}/.hack"

cat >"${wrapper_path}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ -d "\${HOME}/.local/share/mise/shims" ]; then
  export PATH="\${HOME}/.local/share/mise/shims:\${PATH}"
fi
export HACK_EXECUTION_MODE="${mode}"
export HACK_DAEMON_DISABLE_DOCKER_EVENTS="\${HACK_DAEMON_DISABLE_DOCKER_EVENTS:-1}"
export HACK_ASSETS_DIR="\${HACK_ASSETS_DIR:-${assets_dir}}"
exec "${bun_bin}" "${repo_root}/index.ts" "\$@"
EOF

chmod +x "${wrapper_path}"

cat <<EOF
Installed slim hack wrapper:
  ${wrapper_path}

Recommended exports:
  export PATH="${bin_dir}:\$PATH"
  export HACK_EXECUTION_MODE="${mode}"

This wrapper is for managed Codex/CI containers and intentionally skips:
  - hack global install
  - Caddy/CoreDNS
  - Loki/Grafana
  - local CA/TLS bootstrap
EOF
