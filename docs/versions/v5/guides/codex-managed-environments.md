# Managed environments

A managed coding-agent container is a separate execution environment. Confirm its
OS/architecture, writable paths, process/snapshot lifecycle, network policy,
project toolchain and task-time secret delivery before installing tools.

## Select an applicable distribution

The published next.5 native bundle targets Apple Silicon macOS. It is not a Linux
cloud-agent installer. A provider's Ubuntu VM cannot run that archive. Select the
v4 documentation for the published Linux portable path, or qualify a separately
identified distribution before writing a different installation recipe. A source
checkout or private helper is not proof of a published Linux v5 artifact.

On a compatible existing Mac, follow [Install](../../site/install.md) and the
native preparation contract. The portable/slim concepts below do not establish
native runtime parity or provider provisioning.

## Prepare dependencies and services

Use the repository's pinned toolchain and frozen lockfile. For a Bun project:

```sh
bun install --frozen-lockfile
```

Do not silently fall back to changing the lockfile when installation fails. Other
languages need their own declared tools. Full Compose execution additionally needs
a working Docker daemon, Compose, compatible mounts and application network access.
Run `docker info` and `docker compose version` inside the actual task environment;
an installed client alone is insufficient.

## Deliver secrets at task time

Provide `HACK_ENV_SECRET_KEY` through the provider's approved runtime injection
mechanism only when encrypted-file decryption is required. The actual key must
reach the Hack process. Do not bake it into a Dockerfile, setup snapshot or shell
profile, and do not print the key or decrypted environment as a diagnostic.
Provider setup and agent phases may have different secret lifetimes: verify the
actual task phase instead of assuming setup exports survive.

Inspect masked configuration, then exercise a harmless project command:

```sh
hack env list
hack host exec --scope api -- bun --version
```

This assumes the selected compatible CLI is `hack` on PATH and the project declares
an `api` scope with Bun available on that host. Replace those details with the
project's real tool and scope. Verify application access separately; a masked env
listing does not prove credentials work.

Set `HACK_NO_INTERACTIVE=1` for scripted work and inspect explicit failures rather
than waiting for a terminal prompt. Restart required services after snapshot
restore: disk snapshots do not preserve running processes. No provider resource,
network exposure or account grant is created by these instructions.
