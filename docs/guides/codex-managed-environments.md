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

## Install from a release

Run this in your managed Codex setup script:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-codex-install.sh \
  | bash
```

The installer downloads the latest Hack release tarball, installs the binary into `~/.hack/bin`,
and writes a thin `hack` wrapper with these defaults:

- `HACK_EXECUTION_MODE=codex`
- `HACK_DAEMON_DISABLE_DOCKER_EVENTS=1`
- `HACK_SETUP_SYNC_MODE=warn`

## Recommended setup script

```bash
set -euo pipefail

mise install bun@1.3.5
export PATH="$HOME/.local/share/mise/shims:$PATH"

bun install
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-codex-install.sh \
  | bash
```

## Recommended maintenance script

```bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$PATH"
bun install --frozen-lockfile || bun install
```

If you are developing inside the Hack repo itself, the repo-local helpers are still available:

```bash
bash scripts/install-codex-slim.sh
bash scripts/maintain-codex-slim.sh
```

## Good fit for slim mode

- `hack tickets`
- `hack linear`
- `hack x github`
- `hack env list`
- `hack host exec`
- `hack host shell`
- repo-local docs, specs, and agent setup
- command and config surfaces that do not require the machine-wide runtime stack

If the repo uses the modern env overlay model, provide secret decryption material with
`HACK_ENV_SECRET_KEY` instead of relying on a local `.hack.secret.key` file:

```bash
export HACK_ENV_SECRET_KEY="..."
hack host exec --env qa --scope api -- bun db:migrate
hack host exec --env qa --scope api --target compose -- bun test
```

`hack host exec` and `hack host shell` default to a host-local env view for host commands. Use
`--scope` when you want service-scoped values without running inside that service container. Use
`--target compose` when you explicitly want the container-oriented compose view instead. If you are
checking a value, prefer `hack host exec -- printenv KEY` or
`hack host exec -- sh -lc 'printf "%s\n" "$KEY"'`; plain `echo $KEY` expands in the parent shell
before Hack injects env. Use `hack host exec --shell 'echo $KEY'` if you want Hack to start the
child shell after env injection.

## Not available in slim mode

- `hack global install`
- `hack global up`
- `hack global status`
- `hack global logs`
- explicit Loki-backed log paths such as `hack logs --loki`

When you need full remote runtime orchestration instead of repo-local agent workflows, use the
[remote node container image](remote-node-container.md) instead.
