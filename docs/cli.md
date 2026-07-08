# CLI Overview

Hack v3 is the local-first CLI surface. This page is a supported-surface overview with the
running-things decision guide; for exhaustive per-command options and flags, see the generated
[CLI reference](reference/cli.md) (`bun run docs:cli-reference`, or `hack help <command>` in the
terminal).

## Core commands

- `hack init` — generate `.hack/` (compose + config); `--with claude|codex|both` also hands off to
  agent-assisted onboarding
- `hack up` / `hack down` / `hack restart`
- `hack open` — open/print the project URL
- `hack logs` — tail logs (compose by default; Loki via `--loki`/`--query`)
- `hack ps` / `hack status` — project status
- `hack projects` — registry + running instances; `hack projects prune` removes stale registry
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
- `hack tickets` — optional, opt-in local tickets extension (see [Tickets](#tickets) below)

Run `hack help` for the full command list, or `hack help --all` to include hidden unsupported
experimental commands. Every command and flag on this page is also in the generated
[CLI reference](reference/cli.md).

## Removed surfaces

These commands remain only as migration stubs that print the removal reason and any replacement:

- `hack auth`
- `hack linear`
- `hack org`
- `hack team`

Built-in GitHub workflows were also removed. Use native `git` and `gh`.

## Unsupported experimental

These commands remain source-available but are outside the supported v3 product contract. They are
hidden from default `hack --help` (see `hack help --all`) and print a warning when invoked:

- `hack remote`
- `hack gateway`
- `hack node`
- `hack dispatch`

See [Beta workflows](beta.md) for guides on this surface.

## Agent/scripted ergonomics

- `--json` on `hack up`/`down`/`restart`/`doctor` emits a `{ok, data | error: {code, message}}`
  envelope with stable `E_*` error codes. `--json` on `hack up` implies `--detach`.
- `--no-interactive` (or `HACK_NO_INTERACTIVE=1`) is a global flag: commands never prompt — they
  apply documented defaults or fail fast with `E_INTERACTIVE_REQUIRED`.
- `NO_COLOR` (or `HACK_NO_COLOR`) disables colored/decorated output.

## First-run path

```bash
hack global install
hack init
hack up --detach
hack open
```

Agent-assisted alternative for a new repo: `hack init --with claude|codex|both`. For an existing
project without `.hack/`, use `hack agent onboard`. See
[Agent-first setup](guides/agent-first-setup.md).

## Running things (decision guide)

- One-off command in a fresh service container (deps started as needed): `hack run <service> <cmd...>`.
- Command inside an already-running service container: `hack exec <service> -- <cmd...>`.
- Host script that needs hack-stored env: `hack host exec --env <overlay> --scope <service> -- <cmd...>`
  — this is the way to run repo scripts; never read `.env` files directly.
- Interactive host shell with injected env: `hack host shell --env <overlay> --scope <service>`.
- Call a service over HTTP (from the host or between containers): use its Caddy hostname
  `https://<sub>.<dev_host>`; discover routable URLs with `hack open --json`.

## Branch instances and linked worktrees

`--branch <name>` on `hack up/down/restart/ps/logs/open/run/exec` targets a separate branch
instance (compose project `<name>--<branch>`, hostnames prefixed with the branch).

In a linked git worktree, these commands default the branch instance to the sanitized current git
branch when no `--branch` is passed (`worktree.auto_branch`), so two checkouts never fight over the
same hostnames. A one-line notice is printed to stderr when the default kicks in, so captured
stdout stays clean.

Opt out:

- pass `--branch <name>` explicitly (always wins), or
- set `worktree.auto_branch` to `false` in `.hack/hack.config.json` to target the base instance.

The primary checkout is unchanged: no `--branch` means the base instance.

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
generated files (`.internal/`, `.branch/`, `.env`, `.env.state.json`, `hack.env*.local.yaml`,
`tickets/`). Keep
it committed. If generated files ever leak into git, `hack doctor --fix` untracks them (the files
stay on disk). See [Architecture](architecture.md) for the full file map.

The global config root defaults to `~/.hack`; override it with `HACK_HOME`.

## Tickets

Tickets is an **optional, opt-in** extension — disabled by default and not part of default agent
instructions. Enable it before using the commands below:

```bash
hack tickets setup            # auto-enables the extension and installs the skill
hack tickets create --title "Investigate flaky lifecycle cleanup"
hack tickets list
hack tickets show T-00001
hack tickets status T-00001 in_progress
```

`hack tickets <command>` is an alias for `hack x tickets <command>`; every subcommand except
`setup` requires the extension to already be enabled. See the full guide:
[Tickets](guides/tickets.md).

## Lifecycle

Use `.hack/hack.config.json` `lifecycle` or `startup` for host-side setup instead of ad-hoc
terminal tabs.

For fixed-port helpers such as AWS SSM tunnels or local proxies, declare `singleton.ports`.
Use `onConflict: "adopt"` only when an existing full listener set is equivalent and should be
reused. Adoption does not transfer process ownership: `hack down` leaves adopted external listeners
running.

See [Lifecycle](lifecycle.md) for the full model.
