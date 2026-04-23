# Managed Codex Containers

This guide is for managed Codex or CI-style containers where you control a repo checkout and setup script,
but do not control the host machine or a long-lived Docker Desktop style environment.

Use this path when:

- the container is ephemeral or cache-backed
- you only have a setup script and optional maintenance script
- `hack global install` is too heavy or not applicable
- you want tickets, integrations, docs, and repo-local CLI workflows without the full local host stack

## Published slim image

Hack publishes a portable slim image for managed containers:

- Docker Hub: `hackdance/hack:slim`
- GHCR: `ghcr.io/hack-dance/hack:slim`

Use it as a base image when you want `hack` and Bun preinstalled, then layer any project-specific
toolchains on top. For example, a non-JS repo can extend the image and add Rust, Go, or other
language runtimes without rebuilding the Hack bootstrap each time.

## Codex remote example

This is the intended baseline for a Codex-style remote environment:

- base image: `hackdance/hack:slim`
- repo checked out into the working directory
- `HACK_ENV_SECRET_KEY` injected by the runtime or secret manager
- repo-specific toolchains added on top as needed

Example Dockerfile:

```dockerfile
FROM hackdance/hack:slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
```

If your repo also needs Rust, Go, or Python packaging tools, add them in this layer rather than
waiting for Hack to ship a universal image.

Example setup script:

```bash
set -euo pipefail

bun install --frozen-lockfile || bun install
```

Example maintenance script:

```bash
set -euo pipefail

bun install --frozen-lockfile || bun install
```

Example runtime env injection:

```bash
export HACK_ENV_SECRET_KEY="..."

hack env list --json --show-secrets
hack host exec -- printenv DATABASE_URL
hack host exec --scope api -- bun test
```

CI uses this exact contract in `scripts/portable-container-smoke.sh`: it mounts `examples/basic`
into the slim image, removes the local `.hack.secret.key`, injects `HACK_ENV_SECRET_KEY`, and
verifies both `hack env list` and `hack host exec` resolve the committed env correctly.

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

If you are already inside a container built from `hackdance/hack:slim`, Hack and Bun are already
available and you can skip the installer entirely.

## Recommended setup script

When you are not using the slim image:

```bash
set -euo pipefail

mise install bun@1.3.5
export PATH="$HOME/.local/share/mise/shims:$PATH"

bun install
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-codex-install.sh \
  | bash
```

When you are using the slim image as your base:

```bash
set -euo pipefail

bun install --frozen-lockfile || bun install
```

## Recommended maintenance script

When you are not using the slim image:

```bash
set -euo pipefail

mise install bun@1.3.5
export PATH="$HOME/.local/share/mise/shims:$PATH"

bun install --frozen-lockfile || bun install
```

When you are using the slim image as your base:

```bash
set -euo pipefail

bun install --frozen-lockfile || bun install
```

If you are developing inside the Hack repo itself, the repo-local helpers are still available:

```bash
bash scripts/install-codex-slim.sh
bash scripts/maintain-codex-slim.sh
```

## Good fit for slim mode

- `hack tickets`
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

That same pattern is the recommended portable-container contract:

- mount or check out the repo normally
- inject `HACK_ENV_SECRET_KEY` from the container runtime or secret manager
- let Hack resolve `.hack/hack.env.default.yaml`, overlays, and worktree-local overrides at runtime

Do not bake `.hack.secret.key` into the image.

Portable smoke test:

```bash
bun run smoke:portable-container
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
