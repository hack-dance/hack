# CLI Overview

Hack is the local-first CLI surface. This page is a supported-surface overview with the
running-things decision guide; for exhaustive per-command options and flags, see the generated
[CLI reference](reference/cli.md) (`bun run docs:cli-reference`, or `hack help <command>` in the
terminal).

## Core commands

- `hack init` — generate `.hack/` (compose + config); `--with claude|codex` also hands off to
  agent-assisted onboarding
- `hack up` / `hack down` / `hack restart`
- `hack open` — open/print the project URL
- `hack logs` — tail logs (compose by default; Loki via `--loki`/`--query`)
- `hack ps` / `hack status` — project status
- `hack projects` — registry + running instances; `hack projects prune --project <name>` safely scopes stale registry/container cleanup to one project family (omit `--project` only for an intentional machine-wide prune)
  entries and stops orphaned containers
- `hack env` — env values and local secrets
- `hack host exec` / `hack host shell` — host commands/shells with Hack-resolved env injected
- `hack run <service> [cmd...]` — one-off command in a fresh service container
- `hack exec <service> -- <cmd...>` — command in an already-running service container
- `hack session` — persistent project workspaces (tmux-first)
- `hack doctor` / `hack doctor --fix` — validate and repair local setup
- `hack daemon` — optional local daemon for faster JSON status/ps
- `hack agent onboard` — agent-assisted onboarding for existing projects
- `hack setup` — install/refresh agent integrations (Cursor rules, Claude hooks, Codex skill, MCP)

Interactive diagnostics use compact status rows: healthy groups stay on one line, while warnings
and errors expand with wrapped detail and recovery guidance. `hack doctor --json` remains the stable,
fully detailed automation surface. Generic macOS resolver setup is shown only when those resolver
checks need attention.

On macOS, a healthy terminal connection does not establish browser connectivity.
Use `hack doctor --browser-url https://your-service.hack.local --browser-result fails`
to compare a manually observed browser failure with a verified CLI HTTPS request.
See [macOS browser connectivity](guides/macos-browser-network.md) for supported
observations, Local Network permission guidance and the required browser recheck.

Project resolution for `exec`, `run`, `ps`, `logs`, `open` and host env commands
does not refresh the global project registry. A held registration lock therefore
does not block their resolution or require a retry just to update last-seen metadata.
Use a checkout/path directly, or an existing registry entry with `--project`;
`hack init`, project lifecycle registration and `hack projects` discovery maintain
registrations. Optional `hack projects` discovery coalesces unchanged observations
for one minute and defers refresh when the registry lock is busy. New or changed
checkouts are recorded when the lock is available. Explicit registration and other
registry mutations retain their locking and failure behavior.

Run `hack help` for the full command list, or `hack help --all` to include hidden unsupported
experimental commands. Every command and flag on this page is also in the generated
[CLI reference](reference/cli.md).

Hosted auth/account/org/team, built-in GitHub and Linear workflows, and Hack Tickets are outside the
CLI surface. Use native `git` and `gh` for repository collaboration.

## Unsupported experimental

These commands remain source-available but are outside the supported v3 product contract. They are
hidden from default `hack --help` (see `hack help --all`) and print a warning when invoked:

- `hack remote`
- `hack gateway`
- `hack node`
- `hack dispatch`

Historical remote guides are excluded from the supported documentation.

## Agent/scripted ergonomics

- `--json` on `hack up`/`down`/`restart`/`doctor` emits a `{ok, data | error: {code, message}}`
  envelope with stable `E_*` error codes. `--json` on `hack up` implies `--detach`.
- `--no-interactive` (or `HACK_NO_INTERACTIVE=1`) is a global flag: commands never prompt — they
  apply documented defaults or fail fast with `E_INTERACTIVE_REQUIRED`.
- `NO_COLOR` (or `HACK_NO_COLOR`) disables colored/decorated output.

Generated agent docs, Cursor rules, Codex skills, and the shared `~/.ai/skills/hack-cli` skill carry
the Hack CLI version that generated them. Plain `hack agent prime` prints current guidance without
an integration scan. Use `hack agent prime --check` for an explicit project/global inventory or a
targeted `hack setup ... --check` when diagnosing drift. Missing optional integrations do not
require installation. Repair only affected targets within the authorized scope; use
`hack setup sync --all-scopes` for an explicitly requested full refresh. Read updated guidance after
repair; restart only if the client cannot reload changed hooks or skills.
Ordinary commands, `hack update`, and `hack doctor --fix` never render, repair, remove, or otherwise
mutate integration files. CLI upgrades do not trigger integration updates.

## First-run path

```bash
hack global install
hack init
hack up --detach
hack open
```

Agent-assisted alternative for a new repo: `hack init --with claude|codex`. For an existing
project without `.hack/`, use `hack agent onboard`. See
[Agent-first setup](guides/agent-first-setup.md).

`--with both` has been removed. Choose `--with claude` or `--with codex`;
a second-agent review is a separate, explicitly requested workflow.

### Browser URL preference

`hack open` keeps `dev_host` as the primary routing identity, but automatically opens the OAuth
alias (for example, `myapp.hack.gy`) when `oauth.enabled` is true. Service shorthand and branch
instances follow the same preference, so `hack open api --branch feature-x` resolves the
branch-qualified alias URL.

Set `open.prefer` in `.hack/hack.config.json` to `auto` (the default), `alias`, or `dev`. Override
one invocation with `hack open --prefer <auto|alias|dev>`. Explicit URLs and fully qualified host
targets are preserved. Selecting `alias` without an enabled OAuth alias fails with recovery
guidance instead of silently opening the dev host. For a custom `dev_host` outside Hack's managed
`.hack` namespace, `auto` keeps the development host because Hack does not synthesize a Caddy alias
route for it.

## Running things (decision guide)

- One-off command in a fresh service container (deps started as needed): `hack run <service> <cmd...>`.
- Command inside an already-running service container: `hack exec <service> -- <cmd...>`.
- Host script that needs hack-stored env: `hack host exec --env <overlay> --scope <service> -- <cmd...>`
  — this is the way to run repo scripts; never read `.env` files directly.
- Interactive host shell with injected env: `hack host shell --env <overlay> --scope <service>`.
- Browser/host URL: use `hack open <service> --json`; OAuth aliases are preferred when enabled.
- Container-to-container traffic: use Compose DNS rather than routing back through Caddy.

Service-scoped runtime changes do not run project-wide lifecycle hooks and do not start Compose
dependencies implicitly:

```bash
hack up api worker --env qa --detach
hack restart api --env qa
hack env apply --service api --env qa
```

Full detached startup and inspection are bounded. A timeout returns `E_STARTUP_TIMEOUT`, terminates
the Compose process group, and leaves an explicit repair path instead of hanging indefinitely.
`hack doctor --fix` starts exact project containers left in `Created`; it never removes those
containers as part of this repair.

## Dependency bootstrap integrity

Hack detects package-manager install services by their command or by the explicit
`hack.dependencies.bootstrap=true` Compose label. Before such a service can mutate the runtime,
Hack scans `.npmrc`, `.yarnrc.yml`, and `bunfig.toml` for `${VAR}` credential references and fails
with `E_ENV_KEY_MISSING` when the selected Hack overlay cannot supply them. Values are never
printed.

Detached Compose startup has a 90-second budget by default. For a slow first
install or container launch, set the host CLI environment explicitly:

```sh
HACK_COMPOSE_STARTUP_TIMEOUT_MS=300000 hack up --detach
HACK_COMPOSE_STARTUP_TIMEOUT_MS=300000 hack restart
```

The value must be an integer from 1,000 to 3,600,000 milliseconds; detached startup
and restart reject invalid values before project preparation or teardown. Full and service-scoped
startup/restart use the same setting. The startup phase notice and
`E_STARTUP_TIMEOUT` message report the effective budget. It covers each detached
Compose invocation, including image/container launch and dependency waiting, not
lifecycle hooks or an end-to-end application readiness deadline. A restart repair
attempt has its own invocation budget and is reported separately. Foreground
`up` stays unbounded; `down` retains its separate 90-second limit.

On timeout, Hack terminates the owned Compose process group. Containers may still
be running: inspect `hack ps` and `hack logs` before retrying. Raising the budget
does not fix a failed installer or prove readiness. Set this on the host invocation,
not merely in a container's environment.

To share dependency data only across worktrees with the same lockfile/runtime fingerprint, label
the bootstrap service with a logical top-level Compose volume:

```yaml
services:
  install-workspace:
    image: oven/bun:1.3.9
    platform: linux/arm64 # choose the actual installer target platform
    command: bun install --frozen-lockfile
    labels:
      hack.dependencies.bootstrap: "true"
      hack.dependencies.cache-volume: workspace-dependencies
      hack.dependencies.lockfiles: bun.lock,package.json
      hack.dependencies.runtime-files: .mise.toml
    volumes:
      - workspace-dependencies:/app/node_modules
```

Hack generates a content-addressed volume name from the declared files and installer
image, platform and build configuration. Compatible branch instances select the same
volume; changing these inputs selects a new one. Specify the installer's Compose
`platform` explicitly, or set `DOCKER_DEFAULT_PLATFORM`. When platform or runtime
configuration is unresolved, Hack warns and leaves the original Compose volume
configuration in effect instead of guessing the remote Docker host's architecture.
Explicit volume names or external
volumes can still be shared by Compose; remove that sharing yourself if isolation
is required. No service name such as `deps` is special.

This identity covers declared configuration, not mutable image-tag contents, build
context contents or later Compose overrides. Pin installer images by digest and
include build/runtime source inputs in `hack.dependencies.runtime-files` where
needed. Installers still own serialization, successful-completion markers and
recovery of partial output. Sharing a volume does not provide those guarantees.
The expanded fingerprint selects new volumes on upgrade; old caches are retained.

For explicitly immutable initialization, the opt-in
[`locked-v1` installer protocol](guides/dependency-cache-protocol.md) adds writer
exclusion, verified readiness and fresh-generation recovery. It requires a strict
producer/consumer layout; ordinary cache labels do not enable it automatically.

`hack run` uses the same dependency-volume override as `up` and `restart`, including
in linked worktrees. It skips dependency startup only when the target is running
in the requested environment and its inspected mounts contain the selected cache
volumes. Changed fingerprints, uncertain container identity, or caches mounted only
by other services leave dependency reconciliation to Compose. This does not certify
cache completeness or skip installer/generation commands by itself.

`hack exec` uses the existing container and its existing mounts. After changing a
lockfile/runtime input, use `hack restart` to move the long-running service to the
new cache; a successful one-off `run` does not remount that existing service.
Unlabelled services retain their existing behavior. Old cache volumes are retained;
this change does not prune caches or application data.

## Branch instances and linked worktrees

`--branch <name>` on `hack up/down/restart/ps/logs/open/run/exec` targets a separate branch
instance (compose project `<name>--<branch>`, hostnames prefixed with the branch).

In a linked git worktree, these commands default the branch instance to the sanitized current git
branch when no `--branch` is passed (`worktree.auto_branch`), so two checkouts never fight over the
same hostnames. A one-line notice is printed to stderr when the default kicks in, so captured
stdout stays clean.

Before `up` or `restart`, Hack also checks for a non-terminal instance previously started from the
same worktree. If the worktree's current branch would auto-target a different Compose project, Hack
prints a warning naming both the existing and new targets. Pass `--branch <name>` to make the target
explicit.

`hack down` applies a stricter ownership rule. When a linked worktree's Git branch was renamed and
that exact checkout owns one differently named Compose runtime, implicit down targets the existing
runtime instead of succeeding against an empty newly derived name. Running, Created, and stopped
containers all count as ownership evidence. If the checkout owns multiple runtimes, implicit down
fails and lists them; pass `--branch <name>` to select one. Exact checkout paths and Compose project
families are required, so Hack never retargets to a sibling checkout.

A detached linked worktree has no branch name to derive, so these commands fail instead of silently
targeting the base instance. Pass `--branch <name>` to select an isolated instance, or set
`worktree.auto_branch` to `false` only when intentionally opting into the base instance.

Opt out:

- pass `--branch <name>` explicitly (always wins), or
- set `worktree.auto_branch` to `false` in `.hack/hack.config.json` to target the base instance.

The primary checkout is unchanged: no `--branch` means the base instance.

### Local configuration in linked worktrees

Linked worktrees read eligible primary-checkout local env overrides and managed
extra-host aliases at command time. Later primary changes are visible without
copying files. Tracked project config, generated overrides, runtime state and other
ignored files stay checkout-local. Set `worktree.inherit_local` to `false` in the
worktree's `hack.config.json` to disable inheritance. Slim/Codex execution mode and
CI (`CI=1` or `CI=true`) disable this inheritance automatically.

For Compose aliases, explicit local `internal.extra_hosts` takes precedence over
inherited dynamic aliases, and local dynamic aliases take precedence over both.
`hack internal extra-hosts unset <host>` in a linked checkout hides an inherited
alias without changing the primary. `set` replaces that local removal with an
override. `list --origins` shows each effective dynamic alias and its source file;
plain `list` retains its hostname-to-target JSON format. Successful `up.before`
hooks can create or remove aliases for the same `up` or `restart` operation.

Missing primary configuration is optional. Invalid inherited alias data or
redirected inherited files fail explicitly instead of silently changing routing.
These commands manage the Compose path; the experimental graph runner's direct
Compose-input handling is a separate qualification boundary.

### Disposable cache volumes

Compose preserves named volumes on ordinary `down`, which is correct for application data but can
leave branch-specific build caches behind. Use the explicit cleanup path when those caches are
disposable:

```bash
hack down --prune-caches
# scripted:
hack down --prune-caches --yes --json
```

Hack recognizes named volumes mounted only at `.next` destinations as disposable Next build
caches. For any other framework, library, or language, mark the top-level Compose volume explicitly:

```yaml
services:
  web:
    volumes:
      - turbo-cache:/app/.turbo

volumes:
  turbo-cache:
    labels:
      hack.cache.disposable: "true"
```

The label applies to the exact volume, so the same contract works for Rust `target`, Gradle, Go,
Python, or other generated caches without relying on names or destination guesses.

Hack snapshots mounts before stopping the target and considers a volume removable only when all of
these are true:

- the container belongs to the exact targeted Compose project and checkout;
- the mount type is a named volume;
- `docker volume inspect` independently reports both the exact
  `com.docker.compose.project` label and a `com.docker.compose.volume` label;
- every observed destination's final path segment is `.next`, or the volume itself has
  `hack.cache.disposable=true`.

Interactive cleanup shows the exact volumes, services, and destinations and defaults to “no.”
`--json` and other scripted use must add `--yes`; otherwise the command fails before down with
`E_INTERACTIVE_REQUIRED`. Postgres, Redis, dependency, application-data, bind, external, unlabeled
non-Next, and sibling-checkout volumes do not satisfy the removal contract unless a project author
deliberately marks that exact Compose volume disposable. Hack deliberately does not run broad
`docker volume prune` or `docker compose down -v`.

### Runtime host metadata

Containers started by `hack up`, `hack restart`, and `hack run` receive the effective instance and
public-route metadata. This keeps server-generated links, OAuth callbacks, webhooks, and other
browser-facing URLs isolated when the same project runs in multiple worktrees.

| Variable | Value |
| --- | --- |
| `HACK_BRANCH` | Effective branch slug, or an empty string for the base instance |
| `HACK_COMPOSE_PROJECT` | Effective Compose project name |
| `HACK_DEV_HOST` / `HACK_DEV_URL` | Effective root development host and HTTPS URL |
| `HACK_ALIAS_HOST` / `HACK_ALIAS_URL` | Effective OAuth alias host and URL, when enabled and routed by Hack |
| `HACK_SERVICE_NAME` | Current Compose service name |
| `HACK_SERVICE_URL` | Current service's first public URL, when routable |
| `HACK_SERVICE_URLS` | JSON array of every public URL for the current service |
| `HACK_RUNTIME_METADATA` | Versioned JSON document containing the instance hosts and every routable service's URL list |

Example `HACK_RUNTIME_METADATA` for a branch instance:

```json
{
  "version": 1,
  "branch": "feature-x",
  "composeProject": "demo--feature-x",
  "hosts": {
    "dev": "feature-x.demo.hack",
    "alias": "feature-x.demo.hack.gy"
  },
  "services": {
    "web": {
      "urls": ["https://feature-x.demo.hack"]
    },
    "api": {
      "urls": ["https://api.feature-x.demo.hack"]
    }
  }
}
```

The service map is derived from effective Caddy routes; unroutable services are omitted. Use
Compose DNS names such as `http://api:3000` for container-to-container traffic and runtime metadata
only when a public/browser-reachable URL is required. Explicit project env values retain precedence
over generated metadata for backward compatibility. Existing containers receive the contract after
their next `hack up` or `hack restart`; `hack exec` observes the values already stored in the running
container.

Hack materializes this contract in generated, machine-local Compose overrides. Do not edit or
commit `.hack/.internal/compose.runtime.override.yml` or
`.hack/.branch/compose.<branch>.runtime.override.yml`; runtime commands refresh them and Hack's
managed `.hack/.gitignore` covers them.

Linked worktrees also inherit the project secret key automatically from the primary checkout
through the shared git common dir, so you don't need to copy `.hack.secret.key` by hand. Set
`HACK_ENV_SECRET_KEY` for CI or fully detached environments. `hack doctor` flags divergent secret
keys and `dev_host` collisions across checkouts.

## Environment model

Canonical env files:

- `.hack/hack.env.default.yaml`
- `.hack/hack.env.<overlay>.yaml`
- `.hack/hack.env.local.yaml` (worktree-local override)
- `.hack/hack.env.<overlay>.local.yaml` (worktree-local override)

Use `hack env add`, `hack env unset`, `hack env list`, and `hack env materialize` to manage them.
Use `hack host exec` and `hack host shell` when you want Hack-resolved env injected into host-side
commands.

Use `--local` on env mutations when you want to write to the worktree-local override file instead
of the shared repo file.

`hack env materialize` is only for compatibility output. `hack doctor` will tell you when the
materialized `.hack/.env` or `.hack/.env.state.json` is stale and should be regenerated.

## Project files

Hack owns a committed `.hack/.gitignore` (self-healing on `init`/`up`) that ignores machine-local
generated files (`.internal/`, `.branch/`, `.env`, `.env.state.json`, `hack.env*.local.yaml`). The
retired `tickets/` path remains ignored only so upgrades cannot recommit legacy machine-local
caches. Keep `.hack/.gitignore` committed. If generated files ever leak into git, `hack doctor
--fix` untracks them (the files stay on disk). Runtime metadata is written to
`.internal/compose.runtime.override.yml` for the base instance and
`.branch/compose.<branch>.runtime.override.yml` for branch instances. See [Architecture](architecture.md)
for the full file map.

The global config root defaults to `~/.hack`; override it with `HACK_HOME`.

## Lifecycle

Use `.hack/hack.config.json` `lifecycle` or `startup` for host-side setup instead of ad-hoc
terminal tabs.

For fixed-port helpers such as AWS SSM tunnels or local proxies, declare `singleton.ports`.
Use `onConflict: "adopt"` only when an existing full listener set is equivalent and should be
reused. Adoption does not transfer process ownership: `hack down` leaves adopted external listeners
running.

See [Lifecycle](lifecycle.md) for the full model.
