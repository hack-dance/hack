#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[hack-node] %s\n' "$1"
}

is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
  1 | true | yes | y | on) return 0 ;;
  *) return 1 ;;
  esac
}

project_root_from_env() {
  if [ -n "${HACK_NODE_PROJECT_DIR:-}" ]; then
    printf '%s' "${HACK_NODE_PROJECT_DIR}"
    return 0
  fi
  printf '%s/node-project' "${HACK_NODE_WORKDIR:-/workspace}"
}

initialize_project() {
  local project_dir
  project_dir="$1"

  if ! is_truthy "${HACK_NODE_AUTO_INIT:-1}"; then
    return 0
  fi

  if [ -d "${project_dir}/.hack" ]; then
    log "Project already initialized at ${project_dir}."
    return 0
  fi

  local project_name
  project_name="${HACK_NODE_PROJECT_NAME:-hack-node}"
  log "Initializing project in ${project_dir} (name: ${project_name})."
  hack init --auto --no-discovery --path "${project_dir}" --name "${project_name}"
}

clone_repo_if_requested() {
  local project_dir
  project_dir="$1"
  local git_repo
  git_repo="${HACK_NODE_GIT_REPO:-}"
  if [ -z "${git_repo}" ]; then
    return 0
  fi

  if [ -d "${project_dir}/.git" ]; then
    return 0
  fi

  if [ -n "$(ls -A "${project_dir}")" ]; then
    log "Skipping clone because ${project_dir} is not empty."
    return 0
  fi

  local depth branch
  depth="${HACK_NODE_GIT_DEPTH:-1}"
  branch="${HACK_NODE_GIT_BRANCH:-}"
  if [ -n "${branch}" ]; then
    log "Cloning ${git_repo} (branch: ${branch}, depth: ${depth}) into ${project_dir}."
    git clone --depth "${depth}" --branch "${branch}" "${git_repo}" "${project_dir}"
  else
    log "Cloning ${git_repo} (depth: ${depth}) into ${project_dir}."
    git clone --depth "${depth}" "${git_repo}" "${project_dir}"
  fi
}

configure_gateway() {
  local project_dir
  project_dir="$1"

  if ! is_truthy "${HACK_NODE_GATEWAY_ENABLE:-1}"; then
    return 0
  fi

  if [ ! -d "${project_dir}/.hack" ]; then
    log "Gateway setup requires an initialized project at ${project_dir}."
    exit 1
  fi

  local bind port allow_writes
  bind="${HACK_NODE_GATEWAY_BIND:-0.0.0.0}"
  port="${HACK_NODE_GATEWAY_PORT:-${PORT:-7788}}"
  allow_writes="false"
  if is_truthy "${HACK_NODE_GATEWAY_ALLOW_WRITES:-1}"; then
    allow_writes="true"
  fi

  log "Configuring gateway (bind=${bind}, port=${port}, allowWrites=${allow_writes})."
  hack config set --path "${project_dir}" controlPlane.gateway.enabled true
  hack config set --global controlPlane.extensions.dance.hack.gateway.enabled true
  hack config set --global controlPlane.gateway.bind "${bind}"
  hack config set --global controlPlane.gateway.port "${port}"
  hack config set --global controlPlane.gateway.allowWrites "${allow_writes}"
}

start_tailscale_if_requested() {
  if ! is_truthy "${HACK_TAILSCALE_ENABLE:-0}" && [ -z "${TS_AUTHKEY:-}" ]; then
    return 0
  fi

  if [ -z "${TS_AUTHKEY:-}" ]; then
    log "Tailscale is enabled but TS_AUTHKEY is missing."
    exit 1
  fi

  if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then
    log "Tailscale binaries are missing from runtime image."
    exit 1
  fi

  local socket state_dir gateway_port tailscaled_log tailscaled_pid ready
  socket="${HACK_TAILSCALE_SOCKET:-/tmp/tailscaled.sock}"
  state_dir="${HACK_TAILSCALE_STATE_DIR:-/var/lib/hack/tailscale}"
  gateway_port="${HACK_NODE_GATEWAY_PORT:-${PORT:-7788}}"
  tailscaled_log="${HACK_TAILSCALED_LOG_PATH:-/tmp/hack-node-tailscaled.log}"
  mkdir -p "${state_dir}"
  rm -f "${socket}"

  log "Starting tailscaled in userspace networking mode."
  tailscaled --socket="${socket}" --statedir="${state_dir}" --tun=userspace-networking >"${tailscaled_log}" 2>&1 &
  tailscaled_pid="$!"
  ready="0"
  for _ in $(seq 1 30); do
    if [ -S "${socket}" ]; then
      ready="1"
      break
    fi
    if ! kill -0 "${tailscaled_pid}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if [ "${ready}" != "1" ]; then
    log "tailscaled socket did not become ready."
    if [ -f "${tailscaled_log}" ]; then
      tail -n 60 "${tailscaled_log}" || true
    fi
    exit 1
  fi

  local -a up_args
  up_args=(--socket "${socket}" up --auth-key "${TS_AUTHKEY}" --accept-dns=false --reset --timeout 60s)
  if [ -n "${HACK_TAILSCALE_HOSTNAME:-}" ]; then
    up_args+=(--hostname "${HACK_TAILSCALE_HOSTNAME}")
  fi
  if [ -n "${HACK_TAILSCALE_ADVERTISE_TAGS:-}" ]; then
    up_args+=(--advertise-tags "${HACK_TAILSCALE_ADVERTISE_TAGS}")
  fi
  if is_truthy "${HACK_TAILSCALE_SSH:-0}"; then
    up_args+=(--ssh=true)
  fi

  log "Connecting node to tailnet."
  tailscale "${up_args[@]}"

  if is_truthy "${HACK_TAILSCALE_SERVE:-1}"; then
    local serve_target
    serve_target="${HACK_TAILSCALE_SERVE_TARGET:-127.0.0.1:${gateway_port}}"
    log "Publishing gateway with tailscale serve (${serve_target})."
    tailscale --socket "${socket}" serve --bg "${serve_target}"
  fi
}

write_enrollment_bundle_if_requested() {
  local enroll_path
  enroll_path="${HACK_NODE_ENROLL_PATH:-}"
  if [ -z "${enroll_path}" ]; then
    return 0
  fi

  if [ -f "${enroll_path}" ] && ! is_truthy "${HACK_NODE_ENROLL_FORCE:-0}"; then
    log "Enrollment bundle already exists at ${enroll_path}; skipping."
    return 0
  fi

  local endpoint name labels port
  port="${HACK_NODE_GATEWAY_PORT:-${PORT:-7788}}"
  endpoint="${HACK_NODE_ENDPOINT:-http://127.0.0.1:${port}}"
  name="${HACK_NODE_NAME:-$(hostname)}"
  labels="${HACK_NODE_LABELS:-}"

  mkdir -p "$(dirname "${enroll_path}")"

  local -a args
  args=(node init --json --name "${name}" --endpoint "${endpoint}")
  if [ -n "${labels}" ]; then
    args+=(--labels "${labels}")
  fi

  log "Writing enrollment bundle to ${enroll_path}."
  hack "${args[@]}" >"${enroll_path}"
  chmod 600 "${enroll_path}" || true
}

configure_runtime_defaults() {
  if [ -n "${HACK_DAEMON_DISABLE_DOCKER_EVENTS:-}" ]; then
    return 0
  fi

  if [ -S "/var/run/docker.sock" ]; then
    return 0
  fi

  export HACK_DAEMON_DISABLE_DOCKER_EVENTS=1
  log "Docker socket not detected; disabling docker event watcher."
}

main() {
  local project_dir
  project_dir="$(project_root_from_env)"

  mkdir -p "${HOME:-/var/lib/hack}" "${HACK_NODE_WORKDIR:-/workspace}" "${project_dir}"

  clone_repo_if_requested "${project_dir}"
  initialize_project "${project_dir}"
  configure_gateway "${project_dir}"
  start_tailscale_if_requested
  write_enrollment_bundle_if_requested
  configure_runtime_defaults

  if [ "$#" -gt 0 ]; then
    log "Executing custom command: $*"
    exec "$@"
  fi

  # Persistent home volumes can retain stale daemon pid/socket markers.
  # In containers PID 1 is this script, so stale pid files can falsely look
  # "running". Clear pid/socket files directly before foreground start.
  local daemon_root
  daemon_root="${HOME:-/var/lib/hack}/.hack/daemon"
  log "Clearing daemon pid/socket state in ${daemon_root}."
  mkdir -p "${daemon_root}"
  rm -f "${daemon_root}/hackd.pid" "${daemon_root}/hackd.sock"

  log "Starting hack daemon in foreground."
  exec hack daemon start --foreground
}

main "$@"
