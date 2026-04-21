<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Hack is a local-first developer runtime for running repo environments cleanly on one machine.

Hack v3 narrows the product to the local core:

- project init and runtime orchestration
- stable local routing and TLS
- env management and host/container env injection
- persistent sessions
- diagnostics and recovery
- optional repo-local tickets
- a slim macOS companion for local status, control, and logs

Hack no longer treats hosted auth, the web dashboard, built-in GitHub workflows, or Linear sync as supported product surfaces.

## Core workflow

```bash
hack global install
hack init
hack up --detach
hack open
hack logs --pretty
```

Useful follow-ups:

```bash
hack restart
hack doctor
hack session
hack env list
hack host exec --scope api -- bun test
hack tickets list
```

Portable envs and secrets:

- Commit `.hack/hack.env.default.yaml` and optional `.hack/hack.env.<overlay>.yaml`.
- Keep `.hack.secret.key` out of git, or provide `HACK_ENV_SECRET_KEY` in CI and managed containers.
- Linked git worktrees can reuse an existing checkout-family secret key when their local copy is missing.
- Let Hack inject resolved env directly into runtime commands by default.
- Materialize `.hack/.env` only when you explicitly need a compatibility file.

## What stays in v3

- `hack init`
- `hack up`, `hack down`, `hack restart`
- `hack open`, `hack logs`, `hack ps`
- `hack env`, `hack host exec`, `hack host shell`
- `hack session`
- `hack doctor`, `hack daemon`, `hack crash-capture`
- `hack tickets`
- macOS app for local project/global status and Ghostty-backed bottom logs panel

## What was removed

- hosted Hack auth and account/org/team management
- built-in GitHub integration flows
- built-in Linear integration flows
- web dashboard and browser control plane
- auth-broker service and hosted control-plane dependency

Removed commands remain as compatibility stubs and print migration guidance.

## Env model

Hack’s canonical env files live in `.hack/`:

- shared repo files:
  - `.hack/hack.env.default.yaml`
  - `.hack/hack.env.<overlay>.yaml`
- worktree-local override files:
  - `.hack/hack.env.local.yaml`
  - `.hack/hack.env.<overlay>.local.yaml`

Resolution order:

1. shared default
2. shared selected overlay
3. worktree-local default
4. worktree-local selected overlay

Secrets use the project key provider. Key lookup order is:

1. current checkout `.hack.secret.key`
2. shared key under the git common dir for linked worktrees
3. `HACK_ENV_SECRET_KEY`

## Install

Homebrew:

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/hack
```

Shell installer:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh \
  | bash
```

## Portable containers

Hack ships public runtime images on Docker Hub and GHCR:

- full remote runtime: `hackdance/hack:latest`
- slim portable base: `hackdance/hack:slim`

Use the full image when you need the remote node runtime with bundled Docker CLI, compose, and
gateway bootstrap. Use the slim image as a base for Codex, CI, or other managed containers where
you want `hack`, Bun, and the local-first env/session/tickets workflows available without the full
host stack.

For portable container setups, pass `HACK_ENV_SECRET_KEY` at runtime instead of copying
`.hack.secret.key` into the image.

## macOS app

The macOS app is a thin local companion. It keeps:

- project list and project detail
- global and daemon status
- start/stop/restart/open actions
- log entrypoints
- trust and doctor guidance
- menu bar quick actions
- the Ghostty-backed bottom panel for local logs and terminal output

## Experimental remote

Remote, gateway, node, and dispatch remain in the repo as unsupported experimental surfaces. They are not part of the default v3 product story and are not release blockers unless they break the local core.

## Docs

- [CLI reference](./docs/cli.md)
- [Environment model](./docs/env.md)
- [Architecture](./docs/architecture.md)
- [Sessions](./docs/sessions.md)
- [Tickets](./docs/guides/tickets.md)
