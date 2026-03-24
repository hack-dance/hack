# Managed Codex Containers

This guide is for managed Codex or CI-style containers where you control a repo checkout and setup script,
but do not control the host machine or a long-lived Docker Desktop style environment.

Use this path when:

- the container is ephemeral or cache-backed
- you only have a setup script and optional maintenance script
- `hack global install` is too heavy or not applicable
- you want tickets, integrations, docs, and repo-local CLI workflows without the full local host stack

## What slim mode does

Slim mode is enabled by setting `HACK_EXECUTION_MODE=codex` or `HACK_EXECUTION_MODE=slim`.

It is designed to skip machine-level Hack surfaces:

- Caddy
- CoreDNS
- Loki
- Grafana
- local CA and TLS bootstrap
- Docker event watching in `hackd`

This mode is intentionally not a substitute for a full local workstation setup.

## Install from a cloned repo

Run this in your managed Codex setup script after Bun is available:

```bash
bash scripts/install-codex-slim.sh
```

The script installs a repo-local `hack` wrapper into `~/.local/bin/hack` and sets the wrapper defaults to:

- `HACK_EXECUTION_MODE=codex`
- `HACK_DAEMON_DISABLE_DOCKER_EVENTS=1`
- `HACK_SETUP_SYNC_MODE=warn`

## Recommended setup script

```bash
set -euo pipefail

mise install bun@1.3.5
export PATH="$HOME/.local/share/mise/shims:$PATH"

bun install
bash scripts/install-codex-slim.sh
```

## Recommended maintenance script

```bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$PATH"
bash scripts/maintain-codex-slim.sh
```

## Good fit for slim mode

- `hack tickets`
- `hack linear`
- `hack x github`
- repo-local docs, specs, and agent setup
- command and config surfaces that do not require the machine-wide runtime stack

## Not available in slim mode

- `hack global install`
- `hack global up`
- `hack global status`
- `hack global logs`
- explicit Loki-backed log paths such as `hack logs --loki`

When you need full remote runtime orchestration instead of repo-local agent workflows, use the
[remote node container image](remote-node-container.md) instead.
