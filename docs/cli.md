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

Project names in the registry and `--project`/MCP selectors use the same lowercase,
hyphenated key: for example, `my_app` selects `my-app`. Existing registry spellings
remain readable aliases; a later registration of that checkout canonicalizes the
name while preserving its project ID. This does not rename Compose projects,
volumes, hosts or the name in project configuration.

Because a `--project` argument is sometimes a pasted value, Hack never prints the
argument or a slug derived from it. A value containing `=` or other characters
outside a project name is refused with fixed text. An alias spelling that matches
no registered project is not named either: errors say "Unknown project", and
`hack projects --json`/`hack status --json` report `"filter": null` with
`"filter_redacted": true` (and filter without the daemon).

If multiple registrations share a canonical name, selection refuses all aliases,
including an exact spelling. Inspect `hack projects` and use `--path` to address a
specific checkout before renaming or pruning the conflicting registration. A
missing checkout does not authorize another repository to take over its identity;
automatic relocation requires proof that both checkouts belong to the same Git
worktree family. Independent clones remain separate even when their remotes match.
Prune also refuses colliding aliases without a project filter, and checks runtime
working directories against registered checkout/worktree paths before treating a
runtime name as an alias. Inspect the conflicting entries before retrying cleanup.

Lookup, registration updates and removal also refuse a selected project ID that
belongs to multiple entries, even if one checkout is missing. Removal checks every
requested ID under the registry lock before deleting any entry; an ambiguous ID
leaves the entire batch unchanged. Creating a registration also refuses an ID
collision. Unrelated duplicate IDs remain visible and do not block operations on
unique IDs. Optional registration touches defer on ambiguity so they do not break
read commands. Updates persist newly observed last-seen or configured host
metadata even when no existing field changes.

Project resolution for `exec`, `run`, `ps`, `logs`, `open` and host env commands
does not refresh the global project registry. A held registration lock therefore
does not block their resolution or require a retry just to update last-seen metadata.
Use a checkout/path directly, or an existing registry entry with `--project`;
`hack init`, project lifecycle registration and `hack projects` discovery maintain
registrations. Optional `hack projects` discovery coalesces unchanged observations
for one minute and defers refresh when the registry lock is busy. Stale optional
upserts check before Git and configuration discovery, then again before staging
an owner, so an observed busy lock avoids work that would be discarded. These
observations never grant ownership: an apparently absent lock still requires
atomic acquisition. New or changed checkouts are recorded when the lock is available.
A registry touch reuses its configuration and canonical checkout paths for
freshness and any update. A later configuration change is picked up by the next
invocation, even within the one-minute freshness interval. Updates still reread
the registry under the lock so they preserve concurrent registrations. An unchanged
primary checkout refresh skips Git discovery only after that locked reread confirms
its paths, configuration, and unique registration. It still removes missing sibling
records; changed or ambiguous registrations use the normal Git checks.
Registration combines repository identity and branch discovery in one Git call for
ordinary committed checkouts; repositories without commits and unusual ref output
retain separate branch discovery. Linked worktrees still verify their shared
repository identity before joining an existing registration.
Explicit registry mutations wait up to ten seconds with jittered retries, reread
the registry under the lock, and publish complete updates by atomic rename.
A slow live writer is never evicted
because its lock is old. A confirmed dead owner can be recovered; an occupied or
reused PID is treated as live, and uncertain ownership is preserved.

Recovery is serialized separately so competing cleanup attempts cannot delete a
new writer's lock. If a recovery process itself crashes, its recovery guard may
need offline inspection after all writers have stopped; age alone never authorizes
removing it. Interrupted writes may leave uniquely named `.tmp` or `.owner` files
beside `projects.json`; these are never used as registry input. Preserve the current
registry and inspect ownership before removing abandoned files. This concurrency
guarantee applies to cooperating v5 writers. Older v4 writers sharing the same
registry still use their older lock protocol; use separate `HACK_HOME` directories
when running the two versions concurrently.

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
- A `--path` (or working directory) without a `.hack/` project reports `E_PROJECT_NOT_FOUND`
  from `up`, `down`, `restart`, `ps`, `logs`, `run`, `exec`, `open`, `tui`, `branch ...`,
  `config get`/`set`, `env ...`, `host exec`/`shell` and `project owner`/`target`/`task`, for
  example `hack ps -p <dir> --json` and `hack branch list -p <dir>`. Under `--json` it is one
  error envelope; without `--json` it is one closed error line, `E_PROJECT_NOT_FOUND: <message>`,
  and no stack trace. The logger adds its own prefix: the console logger (`HACK_LOGGER=console`)
  prints `ERROR: E_PROJECT_NOT_FOUND: ...` on stderr, gum prints a styled `ERROR` level on
  stderr, and clack prints a `■` marker on stdout after its `│` guide line. `project target` and
  `project task` use their own message, and `target` adds a
  `detail`. These commands report something else:
  - `tui` without a terminal refuses for that reason first.
  - `env get` never prints a failure reason, since its output is raw values: it prints one fixed
    line on stderr, with or without `--json`.
  - `config validate`, `plan`, `import` and `adopt` read native configuration and keep their own
    refusals: `E_NATIVE_PROJECT_UNSUPPORTED` for `validate`/`plan`, a refused preview for
    `import --dry-run`, and `E_CONFIG_INVALID` for `adopt`.
  - `init`, `doctor`, `crash-capture`, and the `setup`, `mcp` and `agent` commands do not need a
    project.

  `tests/missing-project-error-code.test.ts` pins each command that takes `--path`.
- Known Hack errors and closed native runtime refusals print their message only, never a stack
  trace; set `HACK_DEBUG=1` to add the stack. Unexpected exceptions always print their stack.
- `--no-interactive` (or `HACK_NO_INTERACTIVE=1`) is a global flag: commands never prompt — they
  apply documented defaults or fail fast with `E_INTERACTIVE_REQUIRED`.
- A run whose stdin or stdout is not a TTY (piped input, an agent harness, CI) is treated the same
  way, with or without the flag: the command resolves every prompt by its documented
  non-interactive policy within milliseconds and never waits on a prompt. Confirmations that have
  a safe default apply it (`hack env unset KEY` removes the key; `hack doctor --fix` applies safe
  remediations and skips destructive ones with a note); prompts that need a real answer fail
  closed with `E_INTERACTIVE_REQUIRED`, naming the flag or argument that makes the invocation
  scriptable (for example `hack update --yes`, `hack mcp --all`, `hack session attach <name>`).
  Set `HACK_NO_INTERACTIVE=1` explicitly in scripts anyway so the intent is visible.
- `NO_COLOR` (or `HACK_NO_COLOR`) disables colored/decorated output.

Generated agent docs, Cursor rules, Codex skills, and the shared `~/.ai/skills/hack-cli` skill carry
the Hack CLI version that generated them. Plain `hack agent prime` prints current guidance without
an integration scan. Use `hack agent prime --check` for an explicit project/global inventory or a
targeted `hack setup ... --check` when diagnosing drift. Missing optional integrations do not
require installation. Repair only affected targets within the authorized scope; use
`hack setup sync --all-scopes` for an explicitly requested full refresh. Sync refreshes only installed
Hack-owned integrations; add `--install-missing` to create missing ones (see
[integration setup](integrations.md#refresh-only-hack-setup-sync)). Read updated guidance after
repair; restart only if the client cannot reload changed hooks or skills.
To move from standalone skill and rule files to the `hack` plugin, preview with
`hack setup migrate`, then run `hack setup migrate --apply` after the plugin loads; apply writes a
backup manifest that `hack setup migrate --rollback-manifest <manifest>` restores (see
[migrate standalone files](integrations.md#migrate-standalone-files-to-the-plugin)).
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

For `run`, `exec`, `host exec`, `env exec`, `x` and the Beta `dispatch run`, Hack options go before
the child command.
From the child command's first word on, every argument belongs to the child, including flags
that Hack also defines: `hack run web bun --version` runs `bun --version` in the container
rather than printing Hack's version, and a child `--json` does not switch Hack's own error output
to JSON. A `--` before the child command is optional and is not passed on; a later `--` (as in
`hack run web npm test -- --watch`) reaches the child unchanged.

### Option parsing

Hack parses options with the resolved command's own options plus the global ones, so each command
keeps its own short flags and option types. `-p` is `--path` for project commands (`init`, `up`,
`down`, `ps`, `logs`, `env ...`, `config ...`, `setup ...`) and `--port` for `hack ssh`. Both
refusals below are `E_USAGE`:

- A long option that only another command declares is refused as
  `Option(s) not valid for "<command>": --<option>`, for example `hack doctor --follow`.
- A short spelling the command does not declare is unknown to it, even when another command
  declares it. `hack doctor -f` refuses as `Unknown option '-f'. To specify a positional argument
  starting with a '-', ...`, the same refusal as a spelling no command declares, such as `-x`.
  (`-f` is `--follow` for `logs` and `global logs`.) In a group of short flags, such as `-fd`, the refusal
  names the first unknown letter without its dash (`Unknown option 'f'`).

An option placed before the command name, as in `hack -p <dir> up`, is read as that command reads
it. There is one remaining edge: when a spelling placed before the command name is a flag in one
command and takes a value in another, Hack reads it as a flag, so it never consumes the command
name. No spelling in the current CLI has this conflict. Put options after the command name to
avoid it.

Per-command parsing replaced one parse over every command's options. Comparing the old and new
parsers on edge cases found two differences:

- The intended one: `-p <dir>` on a project command (for example `up -p /x` or
  `--no-interactive up -p /x`) now sets `--path`. The old parser set `ssh`'s `--port`, which the
  command then refused.
- A short spelling only another command declares is still refused, with different text. The old
  parser read it as that command's long option and refused it as not valid: `doctor -f` and
  `doctor -d` gave `Option(s) not valid for "doctor": --follow` and `--detach`, `ps -fd` gave
  `--follow, --detach`, and `doctor -c --json` (`-c` takes a value for `agent init`) gave an
  "argument is ambiguous" error. Each now gives `Unknown option '<spelling>'`, and `ps -fd` gives
  `Unknown option 'f'`.

These cases parse the same as before: `--help --all`, `help --all`, `-- up`,
`--json run web tool --json`, `--path /x up`, `logs --tail`, `up --tail`, `ssh --path /x` and
`x ext cmd -p 1` (where `-p 1` belongs to the extension command).
`tests/cli-per-command-options.test.ts` pins the short-spelling refusal for every short spelling
that `doctor` does not declare.

`session exec` takes the workspace command as one argument, so quote a command that has its own
arguments or flags: `hack session exec ws "npm --version"`. Hack options go before it, and an
unquoted `hack session exec ws npm --version` refuses with a hint to quote the command instead
of printing Hack's version.

Service-scoped runtime changes do not run project-wide lifecycle hooks and do not start Compose
dependencies implicitly, except declared shared-cache installers needed by the selected services:

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

Detached Compose startup runs in two phases, each with its own budget:

| Phase | Compose invocation | Default | Variable | Range (ms) |
| --- | --- | --- | --- | --- |
| Image build/pull and container creation | `up --no-start` | 30 minutes | `HACK_COMPOSE_IMAGE_TIMEOUT_MS` | 1,000–14,400,000 |
| Start and dependency wait | `up -d --no-build` | 90 seconds | `HACK_COMPOSE_STARTUP_TIMEOUT_MS` | 1,000–3,600,000 |

A first-time build or a large image pull therefore does not consume the start
budget. Raise the budget for the phase that was hit, on the host CLI invocation
rather than in a container's environment:

```sh
# Slow first build or pull of a large image
HACK_COMPOSE_IMAGE_TIMEOUT_MS=3600000 hack up --detach
# Slow container start or a dependency that is slow to become healthy
HACK_COMPOSE_STARTUP_TIMEOUT_MS=300000 hack up --detach
HACK_COMPOSE_STARTUP_TIMEOUT_MS=300000 hack restart
```

Detached startup and restart reject invalid values before project preparation or
teardown. Full and service-scoped startup/restart use the same settings. The
startup notice reports both effective budgets. On expiry, `E_STARTUP_TIMEOUT`
names the phase that was hit, its budget, and the variable that raises it; with
`--json`, `error.detail` carries `composePhase` (`images` or `start`),
`budgetMs`, and `budgetEnv`. The start budget covers container start and Compose
`depends_on` waiting, not lifecycle hooks or an end-to-end application readiness
deadline. A restart repair attempt has its own budgets and is reported
separately. Foreground `up` stays a single unbounded Compose invocation; `down`
retains its separate 90-second limit.

On timeout, Hack terminates the owned Compose process group of that phase. After an
image-phase timeout no container was started by that attempt, but containers may
have been created or recreated. After a start-phase timeout containers may still be
running. Inspect `hack ps` and `hack logs` before retrying. Raising a budget does not
fix a failed installer or prove readiness.

Services with `pull_policy: always` still pull again in the start phase because
Compose applies that policy on every `up`; such pulls count against the start
budget.

Native authored projects with persistent storage also prove their storage with
short-lived helper containers. Each helper proof (one storage carrier: dependency
check, target observation, helper create, policy, start, response and cleanup) has
its own budget, separate from the start budget:

| Budget | Default | Variable | Range (ms) |
| --- | --- | --- | --- |
| One native storage carrier | 90 seconds | `HACK_NATIVE_STORAGE_TIMEOUT_MS` | 1,000–600,000 |

`HACK_COMPOSE_STARTUP_TIMEOUT_MS` neither shortens nor lengthens a storage proof:
carriers follow only `HACK_NATIVE_STORAGE_TIMEOUT_MS`. Storage
proofs that run while a native `up` or `restart` builds and starts workloads do not
consume the start budget: their elapsed time extends the start deadline, and each
proof stays bounded by its own carrier budget. Each Docker command inside a carrier
keeps its fixed 10–15 second cap.

The two variables bound different things:

- Per proof: each storage carrier ends within `HACK_NATIVE_STORAGE_TIMEOUT_MS` (S).
- Per start phase: the storage time excluded from one `up` or `restart` start
  deadline may total at most 16 × S or 1 hour, whichever is smaller (24 minutes at
  the 90-second default; 1 hour from S = 225,000 up). The start deadline moves
  later by at most that cap. A proof that would start after the cap is spent is
  refused before it runs, and a proof that ends past the cap refuses the phase.
- Whole phase: the workload phase therefore ends within
  `HACK_COMPOSE_STARTUP_TIMEOUT_MS`, plus the cap, plus at most one in-flight
  guard proof. Raising S raises both the per-proof bound and the cap; raising the
  start budget never changes either.

When a carrier budget or the whole-phase cap runs out, the command reports the
closed effect reason `storage-budget` in `error.detail.native_compose_effect_refusal`,
and the human summary names `HACK_NATIVE_STORAGE_TIMEOUT_MS`. A refusal with its own
cause, such as a helper policy refusal, keeps that reason even when it is caught after
the carrier deadline; raising the storage budget does not address it. Exhaustion leaves the
same retained, uncertain state as any other storage refusal; inspect saved state
before retrying.

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

Before a scoped `up`, `restart`, or a consumer `run`, Hack executes each needed cache installer
with the same Compose files and selected service environment, using `run --rm --no-deps`.
Installers must be idempotent and coordinate concurrent writers (for example, a lock and a ready
marker inside the volume). They run even for warm caches so an empty or interrupted cache cannot
be mistaken for a ready one. No project lifecycle hook or unrelated dependency is started.
A failed installer leaves existing consumer containers untouched; JSON lifecycle commands return
`E_DEPENDENCY_BOOTSTRAP_FAILED`. Each initializer in detached scoped `up` and targeted `restart` uses the configured
`HACK_COMPOSE_STARTUP_TIMEOUT_MS` budget and reports `E_STARTUP_TIMEOUT` on expiry.
That budget also covers any installer image pull or build, because `run` acquires
the image itself. The subsequent Compose launch has its own phased budgets. Consumer `run` and foreground
scoped `up` retain a separate ten-minute initializer deadline.

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
public-route metadata. This applies to `.hack/docker-compose.yml` projects and to authored
`.hack/hack.project.json` projects, on the default Compose backend and on the native backend
(`HACK_RUNTIME_BACKEND=native`). It keeps server-generated links, OAuth callbacks, webhooks, and
other browser-facing URLs isolated when the same project runs in multiple worktrees. Every path
emits the same keys and document shape from the same shared builder.

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

With the Compose backend, Hack materializes this contract in generated, machine-local Compose
overrides. Do not edit or commit `.hack/.internal/compose.runtime.override.yml` or
`.hack/.branch/compose.<branch>.runtime.override.yml`; runtime commands refresh them and keep them
out of `git status` (see [ignore rules](env.md#ignore-rules-committed-hackgitignore)).

With the native backend, foreground `hack up` and `hack restart` add the same values to the
normalized Compose input that native review checks. They are public container environment, not
private managed values, so `hack exec` and native `hack run` see them too. The service URLs come
from the reviewed route labels, and startup refuses before serving if they differ from the reviewed
route plan. When a native HTTPS frontend is selected with a port other than 443
(`HACK_NATIVE_HTTPS_PORT`), `HACK_DEV_URL`, `HACK_ALIAS_URL` and every service URL include that
port; host variables never do. Native-specific limits:

- A graph whose data was retained by an earlier release is restored exactly as it was admitted and
  does not gain these variables. It receives them after it is next started without retained data.
- These values are part of the retained graph's reviewed input. A retaining restart that changes
  only route hostnames (for example a domain migration) remains supported, because the generated
  metadata keys are excluded from the hostname-change fingerprint. Values you declare for these
  keys in `.hack/docker-compose.yml` still count. Changing the native HTTPS port, or selecting or
  removing the native HTTPS frontend when its port is not 443, changes the metadata without a
  hostname change, so the retained graph refuses to start. Start it with its original HTTPS
  frontend selection and port.

For an authored `.hack/hack.project.json` project, the configuration compiler carries the values as
public `runtime` bindings (see the [compiler reference](reference/native-config-compiler.md)), so
they are reviewed with the rest of the plan and are never managed or secret values. The precedence
matches Compose-file projects: a managed project env value or any authored `environment` directive
for one of these keys (literal, default, reference, endpoint or `unset`) wins over the generated
value. The hosts come from the compiler's routing resolution:

- `HACK_DEV_HOST` is the resolved project origin's host (for example
  `feature-x.demo.hack.local`). Without a routing resolution it is the compiler's generated
  `<name>.hack.local`, prefixed with the selected branch when there is one.
- `HACK_ALIAS_HOST` is the host of the alias named by `routes.oauth_alias`, when set.
- Service URLs list each `routes.http` route for that service in route-name order, the route origin
  before its aliases, so `HACK_SERVICE_URL` is the development origin.
- `HACK_BRANCH` is the routing resolution's branch, or the selected `--branch` instance when no
  routing resolution exists.
- On the Compose backend `HACK_COMPOSE_PROJECT` is the instance's actual Compose project
  (`hack-nc-...`), and URLs are portless. On the native backend it is `<name>` or
  `<name>--<branch>`, as for native image projects, and URLs carry a selected non-443
  `HACK_NATIVE_HTTPS_PORT`. Authored native graphs are not routed, so they have no alias and no
  service URLs; the port appears only in `HACK_DEV_URL`.

Authored native `hack exec` sees the values stored in the running container, and native one-off
`hack run` uses the admitted service environment. A graph started before this release gains them
on its next `hack up` or `hack restart`.

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

Hack owns a committed `.hack/.gitignore` (created by `init`; for an existing project without it,
`doctor` warns and `doctor --fix` creates or repairs it; a read-only or symlinked file is reported
and never replaced) that ignores
machine-local generated files (`.internal/`, `.branch/`, `.env`, `.env.state.json`,
`hack.env*.local.yaml`). The retired `tickets/` path remains ignored only so upgrades cannot
recommit legacy machine-local caches. Keep `.hack/.gitignore` committed. Runtime commands (`up`,
`down`, `restart`, `run`, `exec`) do not write it: they add the same patterns to the repository's
local `info/exclude`, so `git status` stays unchanged. Never commit `.hack/.internal/`. If generated
files ever leak into git, `hack doctor --fix` untracks them (the files stay on disk). Runtime metadata is written to
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
