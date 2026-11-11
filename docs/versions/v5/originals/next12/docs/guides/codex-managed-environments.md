# Hack in Codex Cloud and remote development environments

Use the existing repository, its encrypted env configuration, and its pinned
dependencies to prepare a development environment on another machine. Start by
choosing the target and Hack version explicitly. A portable CLI installation gives
you env resolution and host commands; starting a full application also requires
that project's runtime, services, network access, and credentials.

The optional `hack-remote` skill guides this workflow. A plugin on your laptop does
not install Hack or enroll a cloud machine. Confirm that the skill is available in
the target task, for example through the repository's supported skill location.

## Choose the execution path

| Target | Useful existing path | Check before starting the app |
| --- | --- | --- |
| Codex Cloud or a managed CI container | Portable/slim CLI and the repository's host commands | Toolchain, key injection during the task, network access, and required services |
| Existing remote development machine with Docker | Hack's Compose workflow | Working Docker Engine and Compose, project dependencies, lifecycle hooks, routing needs |
| Apple Silicon Mac testing v5 | Explicit native prerelease channel | Verified bundle, provider preparation, isolated native home, application acceptance |

The native prerelease installer currently targets Apple Silicon macOS. It is not a
Linux installer or a qualified nested-VM provisioning path. See
[candidate installation](candidate-install.md) and
[native candidate preparation](native-candidate.md). Do not use the unsupported
Hack node/gateway/dispatch surface as a fallback.

For an existing remote machine, establish its identity and the intended checkout
before installation. Read `AGENTS.md`, inspect `git status --short`, and check
`uname -s` and `uname -m`. Creating a cloud machine, publishing or sharing an
environment, and making privileged host changes require authority for that target
and effect. Ordinary setup should reuse the project's existing development path.

## Select a CLI without replacing another channel

Use a reviewed absolute executable path throughout setup and verification. Check
its `--version` and `--help`; do not assume the first `hack` on PATH is the desired
version. An installed native candidate must use its channel launcher, for example
`$HOME/.hack-next/bin/hack-next`. That launcher selects the verified executor and
the version's private homes. Running its raw `hack-cli` binary is not equivalent.

For a portable installation, select a published stable release that contains
`hack-codex-install.sh` and the matching platform archive. Download and review the
script from that same tag. This example uses a caller-supplied approved tag and a
dedicated installation path:

```sh
set -euo pipefail
: "${HACK_INSTALL_TAG:?Set the approved release tag before running this script}"

curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  "https://github.com/hack-dance/hack/releases/download/${HACK_INSTALL_TAG}/hack-codex-install.sh" \
  --output hack-codex-install.sh
```

Review the downloaded script and the release's source and artifact identity before
running it. Select unused dedicated destinations, or the same installation you
intend to update:

```sh
HACK_INSTALL_TAG="$HACK_INSTALL_TAG" \
HACK_INSTALL_BIN="$HOME/.local/share/hack-portable/bin" \
HACK_INSTALL_ASSETS="$HOME/.local/share/hack-portable/assets" \
  bash ./hack-codex-install.sh

hack_cli="$HOME/.local/share/hack-portable/bin/hack"
"$hack_cli" --version
```

The portable installer downloads its platform archive over HTTPS; it does not
implement the native prerelease installer's receipt, inventory, and signature
checks. Use your environment's artifact verification policy. Do not point the
portable installer at a native prerelease archive or claim that installing it also
provisioned a VM.

The wrapper defaults to `HACK_EXECUTION_MODE=codex`, disables Docker event watching,
and selects its installed assets. It does not need the Bun runtime to execute its
compiled Hack CLI. Install the project's own toolchain separately. For a Bun
project, use the repository's pinned Bun version and:

```sh
bun install --frozen-lockfile
```

Resolve lockfile failures instead of silently running an unlocked install. Keep
the same rule in maintenance scripts and when a new branch changes dependencies.

Container systems that accept a custom base image can use a reviewed, pinned digest
of `hackdance/hack:slim` or `ghcr.io/hack-dance/hack:slim`, then add project-specific
tools. Do not assume that an arbitrary managed cloud environment accepts a custom
image. The slim image includes Hack and Bun; it does not provide every language or
application dependency.

## Inject the project key for the correct lifetime

Hack resolves committed `.hack/hack.env.default.yaml`, overlays, and local
overrides. A fresh independent checkout can receive its decryption key through
`HACK_ENV_SECRET_KEY`. Use the target's approved secret manager or direct runtime
injection; enter the value through the provider's secret UI, never through chat,
command arguments, logs, or a checked-in setup script.

The key must be available to the Hack process that decrypts the env. Hack requires
the actual key bytes. An HTTPS proxy secret placeholder cannot satisfy local
decryption. Use non-production access for development and inspect variable names
or masked metadata when checking configuration. Do not copy `.hack.secret.key` into
images, shell profiles, prepared filesystem snapshots, or dependency caches. Do not
save decrypted env to extend the lifetime of an injected key. See
[Env & secrets](../env.md) for key precedence and linked-worktree behavior.

### Current Codex Cloud

Current Cloud records an Install script and Start skill; publication captures the
prepared filesystem, and new tasks use it. Repository refresh preserves caches but
does not rerun installation or startup. Review prepared files before publishing,
then test a new task. See [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments).

Request `HACK_ENV_SECRET_KEY` as a direct environment variable, preferably a
personal value scoped to this environment. It is visible to programs in the task.
Network secrets instead supply proxy placeholders for HTTPS requests, so they are
unsuitable for this key. Configure and test required service access separately.
See [environment variables and network secrets](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets).

Put deterministic tool and dependency installation in the Install script. Put the
selected CLI, env overlay, start command, and readiness check in the Start skill.
Only publish or share when requested. Keep credentials out of prepared files.

### Legacy Codex Cloud

The [legacy environment guide](https://learn.chatgpt.com/docs/environments/cloud-environment)
describes a different lifecycle: secrets are available only during setup and are
removed before the agent phase. Setup exports do not persist. Cached containers
can resume with an optional maintenance script.

For this path, a setup-only key does not authorize or enable later decryption.
Use a separately approved runtime injection mechanism or a secret-free task. Never
write the key or decrypted values into cached files to work around the boundary.
Report runtime credentials as unavailable until a fresh agent-phase check proves
otherwise.

## Verify env resolution without printing secrets

The examples below assume `hack_cli` is the selected absolute executable and
`project_root` is the intended absolute checkout. These are shell variables, not
Hack configuration keys. Set `HACK_NO_INTERACTIVE=1` and `NO_COLOR=1` in the target
command environment so unattended commands fail instead of hanging at prompts.

Replace `DATABASE_URL` with a required key name from the project, and `default`
with the intended non-production overlay. `env explain` reports provenance without
the value. The child checks presence without printing it:

```sh
"$hack_cli" env explain DATABASE_URL --path "$project_root" --env default --json
"$hack_cli" host exec --path "$project_root" --env default \
  -- sh -c 'test -n "$DATABASE_URL"'
```

For service-scoped values, add `--scope SERVICE` to `host exec` and
`--service SERVICE` to `env explain`. Commands run on the current machine with
Hack's resolved env. `host exec` defaults to host-oriented addresses;
`--target compose` selects container-oriented values but does not enter or start a
container. Run the repository's documented test or development command through
`host exec` when it has a supported host workflow. Inspect that command's logging
before providing real secrets.

Do not use `env get`, `env list --show-secrets`, `printenv`, or a shell env dump as a
credential check. A presence check proves injection only; an application health
check must prove that required services are reachable and credentials work.

## Start only a supported runtime

For an existing Compose project, verify the target engine and Compose client:

```sh
docker info >/dev/null
docker compose version
```

These are capability checks; use Hack to start and manage the application's
services. A missing engine is a provisioning requirement, not a reason to retry
`hack up` or assume Docker-in-Docker or nested virtualization will work. Engine
installation requires an authorized host setup. Likewise, installing the native
candidate does not prepare its provider or activate routing/trust.

Once the chosen runtime is ready, inspect the project's lifecycle hooks for the
remote target, then run:

```sh
"$hack_cli" up --detach --path "$project_root" --env default --json
"$hack_cli" ps --path "$project_root" --json
```

Use a bounded application health request and one meaningful development operation
to verify readiness. A running container alone is insufficient. Machine-wide
`hack global` operations and Loki-backed logs are unavailable in slim mode, which
skips Caddy, CoreDNS, Loki, Grafana, local CA/TLS bootstrap, and daemon Docker event
watching. A project that requires those surfaces needs the appropriate authorized
host setup or its documented portable development path.

Record the target, selected CLI path/version, overlay name, start/readiness result,
and remaining gap without credentials. Preserve existing services and application
data; cleanup applies only to resources this task owns and is authorized to remove.

## Contributor checks and current limits

`scripts/portable-container-smoke.sh` exercises an isolated synthetic project in a
CI-built slim image: it injects a synthetic key after removing the fixture key
file, then checks env resolution and host execution. Run it with:

```sh
bun run smoke:portable-container
```

This proves the portable env/host-command contract for that image. It does not
prove Codex Cloud skill loading, secret lifetime in a real task, Docker availability
there, or v5 native application startup on Linux.

For Hack contributors using a reviewed source checkout, the repo-local
`scripts/install-codex-slim.sh` and `scripts/maintain-codex-slim.sh` are separate
helpers. The source wrapper requires the pinned Bun runtime and references that
checkout; it is not the compiled release installer. Use a dedicated destination
when testing it beside another Hack version.

Automatic lightweight runtime provisioning on arbitrary fresh cloud machines,
native Linux qualification, and a complete fresh Codex Cloud application run remain
separate acceptance work. Report them explicitly rather than treating a successful
CLI installation or env test as full application readiness.
