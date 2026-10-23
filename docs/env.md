# Env & secrets

Hack now uses repo-level env overlay files as the canonical project env model.

The short version:

- commit `.hack/hack.env.default.yaml`
- optionally commit `.hack/hack.env.<overlay>.yaml`
- use `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml` for worktree-local overrides
- keep `.hack.secret.key` out of git, or provide `HACK_ENV_SECRET_KEY`
- let `hack up`, `hack run`, `hack restart`, `hack host exec`, `hack host shell`, and env-aware session flows inject values directly at runtime
- use `hack env materialize` only when you explicitly need a compatibility `.hack/.env`

## Current model

Canonical env state lives at the repo root:

- `.hack/hack.env.default.yaml`
- `.hack/hack.env.<overlay>.yaml`
- `.hack/hack.env.local.yaml`
- `.hack/hack.env.<overlay>.local.yaml`

Legacy compatibility note:

- if an older repo already tracks `.hack/hack.env.local.yaml` as the shared `--env local` overlay, Hack keeps reading that file as the shared overlay
- in that compatibility case, worktree-local default overrides are written to `.hack/hack.env.default.local.yaml` so `--local` mutations do not overwrite tracked shared config

Compatibility and local-only state still lives under `.hack/`:

- `.hack/.env`
- `.hack/.env.state.json`
- `.hack/.internal/...`

Encryption key material is local-only by default:

- `.hack.secret.key`
- or `HACK_ENV_SECRET_KEY`

`hack init` now scaffolds `.hack/hack.env.default.yaml` by default.

## Ignore rules (committed `.hack/.gitignore`)

Hack owns a committed `.hack/.gitignore` that keeps machine-local generated
files out of git. Because the file is committed, fresh clones and linked git
worktrees inherit the rules with zero setup. It covers (patterns relative to
`.hack/`):

- `.internal/`
- `.branch/`
- `.env`
- `.env.state.json`
- `hack.env.local.yaml`
- `hack.env.*.local.yaml`
- `.hack.env*.tmp` (staging files an interrupted env write can leave behind)
- `tickets/` (retained only to contain retired machine-local ticket caches during upgrades)

How it is maintained:

- created by `hack init` for a new project, and refreshed when you write
  machine-local env overrides (`hack env set --local`, `hack env hydrate`)
- in an existing project without it (for example one an earlier Hack version
  initialized), `hack doctor` reports the "hack gitignore" check as a warning,
  and `hack doctor --fix` creates the file, or restores its managed block,
  as its own step. Commit the result so fresh clones and worktrees get the
  rules. `hack init` does not repair an existing project. Hack never writes
  through a symlinked `.hack/.gitignore` or `.hack/` (including a `.hack/`
  that links outside the repository); doctor reports that case and leaves it
  alone.
- a read-only `.hack/.gitignore` (for example mode 0444) is never replaced,
  the same policy as for `info/exclude`. When it lacks the managed block,
  `hack doctor` warns and names the fix (make it writable, then run
  `hack doctor --fix`), and `--fix` leaves it unchanged. `hack env set --local`
  and `hack env hydrate` still write the local layer, print the same warning
  on stderr (so `--json` output on stdout stays valid JSON), and leave the
  file unchanged. A read-only file that already has the block is fine.
- runtime commands (`hack up`, `down`, `restart`, `run`, `exec`) never write
  into your working tree to set up ignores, so they leave `git status`
  unchanged. Before they write `.hack/.internal/` or `.hack/.branch/` files,
  they add the same patterns, anchored at the repository root, to a marked
  block in the repository's `info/exclude` (resolved with
  `git rev-parse --git-common-dir`, so one block covers every linked
  worktree). Env commands that write `.hack/.env` (`hack env set` without an
  env config, `hack env materialize`) do the same. That file is local to your
  clone and never committed. The update
  is best-effort: if git is unavailable, or `info/` or `info/exclude` is a
  symlink or not writable, Hack leaves it alone and the command still runs.
- never commit `.hack/.internal/`: it holds machine-local generated state that
  runtime commands rewrite. If it is tracked, `hack doctor --fix` untracks it.
- the entries live inside a marked, hack-managed block; anything you add
  outside the markers is preserved on every rewrite
- the root `.gitignore` still gets a `.hack.secret.key` entry when the secret
  key is first generated (the key lives at the repo root, not under `.hack/`)
- older repos that added `.hack/.internal/` to the root `.gitignore` keep
  working; the entries are equivalent and nothing is removed

Leak detection and repair:

- `hack doctor` runs a "generated files" check: it lists any of the paths
  above (including retired `.hack/tickets/` caches, plus `.hack.secret.key`) that are tracked in git, except a tracked
  `.hack/hack.env.local.yaml`, which is never flagged because older repos may
  intentionally track it as the shared `--env local` overlay (see the legacy
  compatibility note above)
- a tracked `.hack.secret.key` is reported as an error — it is a committed
  secret; rotate it after untracking
- `hack doctor --fix` untracks the offenders with `git rm --cached` (files
  stay on disk) and re-ensures `.hack/.gitignore`; commit the removal
- `--fix` and `--migrate-env-config` cannot be combined with `--json`; run the repair and JSON audit separately so a mutating request is never silently ignored.
  run them separately from a JSON-mode invocation

## File format

Each env file is YAML with:

- `version: 1`
- `environment`
- `secretsprovider: project_key`
- `values`

`values` is split by scope:

- `global`: values applied everywhere
- `<service>`: values applied only for that compose service
- `host`: optional overrides applied to host execution (`hack host exec`, `hack host shell`, and lifecycle hooks/processes)

Example:

```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global:
    GLOBAL_FLAG: "true"
    API_BASE_URL: "https://api.example.com"
  api:
    PORT: "4000"
    SERVICE_TOKEN:
      secure: v1:...
```

Plaintext values are written as scalars. Secret values are written as `{ secure: ... }`.

## Merge rules

Hack resolves env in this order:

1. load `.hack/hack.env.default.yaml`
2. if `--env=<name>` is selected, load `.hack/hack.env.<name>.yaml`
3. load `.hack/hack.env.local.yaml`
4. if `--env=<name>` is selected, load `.hack/hack.env.<name>.local.yaml`
5. merge `values.global`
6. if a service scope is requested, merge `values.<service>` on top

Worktree-local overrides win over shared repo overlays. Service values override global values.
Host execution applies `host` values last. This includes `hack host exec`, `hack host shell`,
and lifecycle hooks/processes, which all run on the host rather than in Compose.

Projects can set a default overlay in `.hack/hack.config.json`:

```json
{
  "env": {
    "defaultOverlay": "qa"
  }
}
```

Use `--env=base` to bypass that default and read only `.hack/hack.env.default.yaml`
(plus local overrides). `default` and `none` are aliases for `base`, in any case, on every
command that accepts `--env`; an overlay file named after one of those spellings is never
selected by name. Any other value must already be a canonical overlay name: lowercase
letters and digits joined by single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`, for example
`qa` or `qa-2`); surrounding whitespace is ignored. Hack never rewrites a requested name,
so `QA`, `q_a` or `X=1` is refused with a fixed `Invalid --env value.` message that does
not repeat the argument, before any project file is read or any child process starts.
See the [command and delivery matrix](#command-and-delivery-matrix) for what each command
does with the selection.

## Metadata-only planning API

Repository integrations can call `resolveProjectEnvMetadata` from
`src/lib/project-env-config.ts` to inspect modern env bindings without obtaining a
key or decrypting values. Pass `projectRoot`, `projectDir`, and `serviceNames`;
optional `envName` selects an overlay, omission uses the project default, and
`null` bypasses that default.

The result contains selection and file paths, declared and unknown scope names,
and per-target key metadata (`scope` and `secret`) for Compose and host execution.
It contains no plaintext values, ciphertext, merged config, or raw layers. It
reads the same ordered files and uses the same scope projection as
`resolveProjectEnvConfig`: later layers override earlier ones, null removes an
earlier binding, and a later value can reintroduce it. Linked worktrees inherit
primary local layers before their own local overrides, subject to the existing
inheritance settings. If a service is named `host`, that scope remains a service
scope rather than an override applied to every host target.

A `null` result means no modern env configuration exists; it does not inspect or
resolve legacy `.env` or secret-store values. Callers retain responsibility for
their existing legacy fallback. Selected managed-env layer reads distinguish a
missing path from a failed read or a dangling symlink. Only regular files
(including readable symlinks to regular files) are read; invalid or unreadable
layers throw a value-free error without YAML excerpts or a nested cause. Project configuration
selection keeps its existing semantics. Metadata inspection never writes key
files or materializes `.env`.

Paths, variable names and scope names can still disclose private project details;
keep this metadata private. It is not portable plan serialization or an atomic
snapshot/admission check. It does not establish that encrypted values can be
decrypted or that runtime injection will succeed.

## Runtime behavior

Direct runtime injection is the default path.

Hack reads the canonical YAML files and injects the resolved env directly into:

- `hack up`
- `hack run`
- `hack restart`
- lifecycle host processes
- `hack host exec`
- `hack host shell`
- `hack session start --env ... --service ...`
- `hack session exec --env ... --service ...`

That means `.hack/.env` is no longer the primary runtime source of truth.

On the Compose backend, Hack still generates `.hack/.internal/compose.env.override.yml`
so each service gets its own environment. The file holds no values: each entry is a
`${HACK_ENV_<digest>_<KEY>}` reference, and Hack passes the resolved values to
`docker compose` through its process environment. Nothing Hack writes there contains a
decrypted value, whether `up` succeeds, fails or is interrupted. The file is written
with mode 0600, and Hack refuses to write through a symlink at that path. A value
reaches the container literally, `$` included.

Only the `docker compose` invocations that read the override (`up`, `run`, `exec`,
`ps` and the dependency cache initialization) receive the `HACK_ENV_*` values. The other
`docker` commands Hack runs around Compose, such as `docker inspect`, `docker logs` and
`docker events` for dependency cache progress and reuse, get the same environment
without them.

Because the file holds only references, a `docker compose -f
.hack/.internal/compose.env.override.yml ...` command run outside Hack (a script, an IDE
integration or a test harness) gets a blank value for every managed variable, with only a
per-variable warning from Compose. Use `hack run` or `hack exec`, or supply the same
`HACK_ENV_*` variables to that command.

A value that a service gets from the global scope uses one `HACK_ENV_*` reference shared
by every such service. A key that a service scope sets keeps a reference of its own for
that service. The Compose client environment therefore grows with the distinct values,
not with services times keys: twenty services that share one 64 KiB global value add
about 64 KiB, not 1.25 MiB. The choice follows which scope sets each key, never the
values, so the override file still holds no value. Compose also receives each global
value under its own name for `${KEY}` interpolation in your Compose file, so a global
value reaches the `docker compose` process twice.

The operating system limits the arguments and environment of a new process (`ARG_MAX`):
1 MiB in total on macOS, and on Linux a quarter of the stack size limit (2 MiB with the
default 8 MiB stack, at most 6 MiB), plus 128 KiB (`MAX_ARG_STRLEN`) for a single
`NAME=value` string. Hack measures the environment the `docker compose` process would
get (your shell environment plus the managed values) before it writes the override or
starts Compose. It keeps 64 KiB for the Compose arguments. When the environment does not
fit, `up`, `restart`, `run` and `exec` fail with `E_ENV_TOO_LARGE`. The message and the
`--json` detail name the limit (`ARG_MAX` or `MAX_ARG_STRLEN`) and give byte counts only,
never a name or a value. To fix it, make large values smaller or remove them (for
example, mount a large credential as a file and pass its path), set a value once in the
global scope instead of in each service scope, or unset large variables in the shell
that runs `hack`.

When you upgrade from an earlier version, read the two subsections at the end of this
section: managed values that contain `$` now reach containers differently, and an
override written by the earlier version can still hold values.

`hack env materialize` is manual by design. Use it only when you need a compatibility file for an external tool that expects `.env` on disk.

Hack writes `.hack/.env` and `.hack/.env.<overlay>` (from `materialize`, legacy
`hack env set`, and the daemon env route) with mode `0600` by atomic replace: a
private temporary file in `.hack/` is written, fsynced and renamed over the target,
so readers never see a partial file. An existing file with group or other access is
tightened to `0600` even when its contents are unchanged. These write and update paths
refuse, with a fixed message that names no file or value, an env file that is a symlink
(including a dangling one) or not a regular file, or one whose `.hack` directory is a
symlink. Replace the link with a regular file or directory to continue. Code paths
that only read an env file do not apply this check and still follow a symlink.

For host execution, `hack host exec`, `hack host shell`, and lifecycle hooks/processes use a host-local view.
That means Hack prefers host-usable values when it can:

- explicit `host` scope values override the normal `global` + `<service>` merge
- common container-only hostnames such as `host.docker.internal` and compose service hosts are rewritten to `127.0.0.1`

Use `--target compose` if you explicitly want the container-oriented compose view instead.

### Upgrading: managed values that contain `$`

Earlier versions wrote each value into the override literally, so Compose interpolated
a `$` inside a managed value: `$VAR` and `${VAR}` became the host or Compose value of
`VAR` (blank when unset), and `$$` became `$`. Now Compose substitutes each reference
once and does not interpolate the value, so the container receives the value exactly as
stored, `$` included. If a managed value contains `$`:

- the container sees a different value after the upgrade, and the next `hack up`
  recreates that service's containers because their configuration changed;
- a value that relied on interpolation (for example `${HOME}/data`) now reaches the
  container unexpanded; store the expanded value instead;
- a value that escaped `$` as `$$` now reaches the container as `$$`; store a single `$`.

Values without `$` reach containers unchanged, and their containers are not recreated.

### Overrides from earlier versions

An override written by an earlier Hack version can still hold literal values. The next
`hack up`, `hack restart`, `hack run` or `hack exec` replaces it or, when it renders no
override, removes it. `hack down` removes it before its lifecycle hooks, the remote target
or `docker compose down` run, so a failed hook, a remote target or a failed Compose down
does not keep it. `hack doctor` reports such a file in its "compose env at rest" check
(counts only, never values), and `hack doctor --fix` removes it.

A legacy adoption (`hack config adopt`) pins the override's exact bytes and file
identity for as long as the adoption exists, and adopted commands never rewrite it. So:

- `hack config adopt`, `hack config adopt --stop` and `hack config adopt --dry-run`
  refuse a literal override before they prepare anything. Run `hack up` once so Hack
  rewrites it with references, then adopt.
- A preparation that an earlier version made over a literal override is never
  published. `hack config adopt --recover --stop` (which retries the stop, then
  publishes) and `hack config adopt --recover` (which completes a pending switch) refuse
  before any original file moves. The switch stays journaled as pending, and the error
  names `hack config adopt --recover --rollback` as the step that releases it. After that
  rollback, run `hack up` and adopt again.
- An active adoption made by an earlier version over a literal override keeps that file. Hack
  never removes it while a prepared, active or pending adoption exists, because removal
  would make the adoption refuse to load. `hack doctor` reports it with this next step.
  To drop the values, stop the adopted containers (`hack down`), run
  `hack config adopt --rollback`, run `hack up` so Hack rewrites the file with references,
  then adopt again with `hack config adopt --stop`.

A removal first moves the file aside, then checks what it moved. If a concurrent Hack
command had just replaced it with a value-free file, that file is put back rather than
deleted. Between the move and the put-back the path is briefly absent, so a Compose
command started by that concurrent Hack command at that moment can fail to find it; run
the command again. If Hack is killed between the move and the delete, the moved file
(`.hack/.internal/.compose.env.override.yml.<id>.remove`) can hold values. `hack doctor`
reports such files by count, and the next removal, `hack doctor --fix`, or `hack up`,
`hack restart`, `hack run` or `hack exec` deletes each one once it is more than a minute
old. A newer one may belong to a removal that is still running, so it is left alone.

Every step that touches the override first checks, without following a symlink, that
`.hack` and `.hack/.internal` are real directories and that the override is a regular
file; a step that moves or deletes something checks the directories again first. If
`.hack`, `.hack/.internal` or the override is a symlink or not a regular file or
directory, a Compose command that renders the override refuses with a fixed message,
and `hack doctor` reports a fixed refusal that names no value. Neither `hack doctor --fix`,
a removal nor the sweep of leftover `.remove` files lists, reads, moves or deletes
anything behind the link. Replace the link with a regular directory or file.

## Choosing the right execution surface

- `hack host exec` / `hack host shell`: run on your host machine with Hack-resolved env injected.
- `hack run <service> ...`: run a one-off command in the compose network with an ephemeral service container.
- `hack exec <service> ...`: run inside an already-running container when you specifically need that container's live filesystem or process context.

For host execution, `--scope` means "which env scope should Hack inject", not "where should this run."
For example, `hack host exec --scope api -- bun db:migrate` still runs on the host.

## Command and delivery matrix

Every command that accepts `--env` resolves it with the same rule: omitted selects
the configured default overlay (`env.defaultOverlay`); `base`, `default` or `none`
selects base layers only; any other value must be a canonical overlay name and selects
that overlay. The table lists every such command; `tests/env-command-matrix.test.ts`
fails when a command gains or loses `--env` without a matching row, or when a row's selectors
drift from the CLI. Commands not listed here refuse `--env` as an option that is not
valid for them (arguments after a standalone `--` belong to the child command).

The **Selectors** column lists the env-related flags each command accepts.
`--service` selects a Compose service scope, `--scope` selects the env scope injected
into a host command, and `--target` on env and host commands chooses the `host` or
`compose` env view. On `up`, `down` and `restart`, `--target` is execution routing
(`auto|local|remote`), not an env view.

| Command | Selectors | Resolution timing | Refresh path | Native and compose limits |
| --- | --- | --- | --- | --- |
| `hack up` | `--env`, `--target` | Once, when services are created; values go into Compose containers and lifecycle hooks/processes, and the selection is recorded for the running stack. | `hack restart` or `hack env apply --service <service>`; editing env files does not change running containers. | Authored native projects receive the same selection before dispatch. |
| `hack down` | `--env`, `--target` | At teardown, for lifecycle down hooks only; omitted reuses a named overlay recorded for the running stack, else the configured default. | None; nothing is delivered to containers. | The native runtime backend refuses `--env`. |
| `hack restart` | `--env`, `--target` | When services are recreated; omitted reuses a named overlay recorded for the running stack, else the configured default, and an explicit `--env` (including `base`) wins. | This is the refresh path for the whole stack or the named services. | Authored native projects receive the same selection before dispatch. |
| `hack run` | `--env` | Per invocation, for the new one-off container. | Each run resolves again. | The native runtime backend refuses `--env`; restart with the selection first. |
| `hack exec` | `--env` | Checked at invocation against the env recorded for the running stack; the command runs with the env the container was created with. Compose exec and native-runtime exec (Compose-file and authored native projects) warn on stderr when the service's resolved env changed since it started. | `hack restart <service>` (or `hack restart --env <name>`); native projects restart as a whole with `hack restart` | Compose refuses when the requested env differs from the env recorded for the running stack; the native runtime backend refuses `--env`. |
| `hack env list` | `--env`, `--service` | Per invocation, read-only; secret values are masked unless `--show-secrets`. | Not needed. | Reads files; no runtime required. |
| `hack env get` | `--env`, `--service` | Per invocation; prints exactly one plaintext value to stdout. | Not needed. | Reads files; refuses native project inputs. |
| `hack env explain` | `--env`, `--service`, `--target` | Per invocation; reports source, precedence and delivery without the value. | Not needed. | Reads files; no runtime required. |
| `hack env apply` | `--env`, `--service` | Runs `hack restart <service>` with the same `--env`, recreating one service. | This is the refresh path for one service. | `--service` is required. |
| `hack env add` | `--env`, `--service` | Selects the file written (`hack.env.<name>.yaml`, or the base file for `base`/`default`/`none`; `--local` writes the local variant). | Running workloads keep old values until `hack env apply` or `hack restart`. | Mutates only env files. |
| `hack env set` | `--env`, `--service` | Alias for `hack env add`. | Same as `hack env add`. | Mutates only env files. |
| `hack env hydrate` | `--env`, `--service` | Selects the local file written, as for `hack env add --local`; imports every entry in one commit. | Same as `hack env add`. | Mutates only the machine-local env file; refuses a git-tracked one. |
| `hack env unset` | `--env`, `--service` | Selects the file the key is removed from, as for `hack env add`. | Same as `hack env add`. | Mutates only env files. |
| `hack env materialize` | `--env`, `--service` | Writes `.hack/.env` once, at invocation. | Rerun `hack env materialize`. | Compatibility output for external tools; runtime injection does not depend on it. |
| `hack env exec` | `--env`, `--service`, `--target` | Per invocation, into one host command (host view by default). | Each invocation resolves again. | Runs on the host, not in a container. |
| `hack env shell` | `--env`, `--service`, `--target` | When the shell starts. | Start a new shell. | Runs on the host, not in a container. |
| `hack host exec` | `--env`, `--scope`, `--target` | Per invocation, into one host command (host view by default). | Each invocation resolves again. | Runs on the host, not in a container. |
| `hack host shell` | `--env`, `--scope`, `--target` | When the shell starts. | Start a new shell. | Runs on the host, not in a container. |
| `hack config validate` | `--env` | Per invocation; resolves the native selection without reading managed env documents. | Not needed. | Authored native projects only; cannot be combined with `--file`. |
| `hack config plan` | `--env` | Per invocation; metadata only (names, scopes, secret flags), never decrypted. | Not needed. | Authored native projects only. |
| `hack project target` | `--env`, `--service` | Per invocation, read-only; reports the overlay selection (explicit, project default or base) without reading env files or values. | Not needed. | Selection only: overlay existence is not checked; no runtime required. |
| `hack project task list` | `--env` | Per invocation, read-only; selects the overlay that each recipe's reviewed env scope is compared with, without reading env files or values. | Not needed. | Selection only; lists recipes and runs nothing, so no runtime is required. |
| `hack project task inspect` | `--env` | Per invocation, read-only; as for `hack project task list`, for one recipe. | Not needed. | Selection only; runs nothing, so no runtime is required. |
| `hack session start` | `--env`, `--service` | When the workspace is created; the name gains `.env-<name>` (`.env-base` for base spellings), and `--up` runs `hack up -d` with the same selection. | Start a new workspace or pass `--env` to `hack session exec`. | Injects into the workspace shell, not into containers. |
| `hack session exec` | `--env`, `--service` | Per command; omitted reuses the selection encoded in the workspace name. | Each command resolves again. | Injects into the workspace command, not into containers. |

### Stale env warning on `hack exec`

`hack up` and `hack restart` record, for each Compose service they create, a keyed
digest of the env set delivered to it. The digest lives in Hack-managed runtime state
(`.hack/.internal/runtime-state.json`) and holds no key name or value. `hack exec`
resolves the same env set again and, when the digest differs, prints one fixed warning
to stderr that names the service and suggests `hack restart <service>`. The command
still runs with the env the container was created with, and stdout stays the target
command's output. The warning never prints a key or value.

The check is advisory. Identical env, state written before this check existed, and a
service whose last targeted restart failed produce no warning. `hack up <service>`,
`hack restart <service>` and `hack env apply --service <service>` refresh only the
named services' digests.

Projects on the native runtime backend run the same check. The foreground `hack up` or `hack restart` records
value-free digests of the env selection it delivered once the run is ready, in
`.hack/.internal/native-env-fingerprints/` (one file per instance, mode 0600). The
record is bound to that run and removed when the foreground ends. `hack exec` resolves
the same selection again: for a Compose-file (image) project, the env for the run's
recorded env name; for an authored project, the managed values for the recorded
`--env` and `--profile` selection. When they differ, it prints one fixed warning to
stderr that names the service and suggests `hack restart`, since native restart is
whole-project. An image-project exec receives freshly resolved values itself, so its
warning says the running service still uses the env it started with. A restart drops
the record once the previous run stops, so a failed restart produces no warning. A
record from another run, a missing record, or any resolution failure produces no
warning. An authored-project check is bounded: after five seconds without a result
it is skipped and the command's output and exit code follow as usual. Ctrl-C during
the check ends the command with exit code 130 without waiting for it.

Two exec paths do not run this check yet: an authored `.hack/hack.project.json`
project on the Compose backend (see
[native configuration with Compose](reference/native-compose-commands.md)), and an
existing Compose project switched with
[`hack config adopt`](reference/native-compose-adoption.md), whose exec runs in the
retained containers.

MCP tools accept no env selector. They run the CLI without `--env`, so each row's
omitted-`--env` behavior applies.

An overlay name is a label for a set of env files. It implies no production authority
and no network or instance isolation: a `prod` overlay still runs on the local stack,
and two overlays share the same instance unless you choose a separate branch instance.

## Common commands

Inspect resolved env:

```bash
hack env list
hack env list --env qa
hack env list --env qa --service api
hack env list --json
hack env list --show-secrets
hack env explain GITHUB_TOKEN --env runner --service installer --target compose
```

`hack env explain` never prints the value. It reports availability, secret classification,
selected/effective scope, source file and precedence, and whether the value is delivered to host
lifecycle code or Compose. Recreate just one service after an env change with:

```bash
hack env apply --service api --env qa
```

`--show-secrets` prints secret values in plaintext instead of the masked default; use it deliberately.

Read one value explicitly:

```bash
hack env get SERVICE_TOKEN --service api
hack env get SERVICE_TOKEN --service api --env qa
hack env get API_BASE_URL --env default
```

`hack env get KEY_NAME` writes exactly the resolved UTF-8 value to stdout, with
**no added newline**, quotes, label, or JSON envelope. Empty values succeed with
zero output bytes. Multiline content and trailing newlines are preserved; shell
command substitution may itself remove trailing newlines. Missing or deleted
values exit nonzero with an error on stderr and empty stdout. Invalid arguments,
malformed env files, and unavailable or denied keys/backends also fail without
printing values, ciphertext, or raw backend errors. `--json` and `--show-secrets`
are not accepted by `get`; help is available separately with `--help`.

Omitting `--env` uses the configured default overlay. `--env default` (also
`--env base` or `--env none`) selects base layers, including local overrides.
An absent optional overlay keeps the existing base/local fallback behavior.
`--service api` selects global plus service values using the same layer ordering
as runtime injection; the default scope is `global`. Linked worktrees use the
same primary-local inheritance and checkout-local precedence as other env flows.
`get` returns that stored scope's value without host-address rewriting.

This explicit command needs no running containers and adds no confirmation.
Existing native keychain authorization still applies. Modern YAML secrets decrypt
only the requested winning entry, so an unrelated missing key or corrupt encrypted
value does not force disclosure or block a plaintext read. Legacy projects retain
their configured backend and declared-key lookup; only the requested overlay/base
key is fetched. The existing encrypted-file backend internally decrypts its sealed
bundle. Empty legacy values are returned as present by `get`; legacy runtime
injection keeps its existing empty-value fallback behavior.

`get` does not migrate or materialize env files, write plaintext artifacts, or add
secret values to diagnostics, MCP tools, or audit output. Treat its stdout as a
secret when the requested value is sensitive; avoid redirecting it into logs or
committed files. Use `hack env explain KEY_NAME` for inspection without disclosure.

Add or update values:

```bash
hack env add API_BASE_URL https://api.example.com
hack env add --env qa API_BASE_URL https://qa.example.com
hack env add API_BASE_URL https://api.example.com --local
```

`hack env set` still works as a compatibility alias for `hack env add`, but `add` is the primary UX now.

### Entering secret values

Never pass a secret value as a command argument: arguments land in shell history and are
visible to other local users and tools through process listings. Use one of these instead:

```bash
# Pipe the value from a secret manager or file; it never appears in argv.
<secret-source> | hack env add SERVICE_TOKEN --service api --secret --value-stdin
hack env add SERVICE_TOKEN --service api --secret --value-stdin < token.txt

# In an interactive terminal, omit the value to use the hidden prompt.
hack env add SERVICE_TOKEN --service api --secret
```

`--value-stdin` works on `hack env add` and `hack env set`, with or without `--secret`.
It reads all of stdin, up to 64 KiB, and strips exactly one trailing newline (`\n` or
`\r\n`), so `printf '%s\n' "$value"` and `printf '%s' "$value"` store the same value; any
further trailing newlines are kept. It refuses, with a fixed message that never repeats the
input and without writing anything:

- an interactive terminal on stdin (pipe the value, or drop `--value-stdin` for the hidden prompt)
- a value argument alongside the flag, including `KEY=value`
- a missing key argument
- empty input, input over 64 KiB, invalid UTF-8, or a NUL byte

`--local` writes to the worktree-local override file (`.hack/hack.env.local.yaml` or
`.hack/hack.env.<overlay>.local.yaml`) instead of the shared repo env file — use it for
per-checkout values you don't want to commit.

Repeating `hack env add` or `hack env set` with the value already stored is a no-op: when
the existing secret decrypts to the same value under the current key, its ciphertext is
kept, so once Hack has written the file it stays byte-identical and Git shows no change.
A hand-edited file (comments, other formatting, or no `global: {}`) is normalized on the
first repeat and stays byte-identical after that. A different value, a plain entry
becoming secret, or an entry that does not decrypt under the current key gets new
ciphertext with a fresh IV. Each command writes one key; a script that sets several keys
is not atomic across them. To write many machine-local values in one commit, use
`hack env hydrate` (below).

Each env file write goes to a hidden `.<file>.<id>.tmp` file in the same directory and
replaces the file by rename, so an interrupted write leaves the previous file in place.
A write killed before the rename can leave that staging file behind. It holds the whole
new layer, so `.hack/.gitignore` ignores `.hack.env*.tmp`, and you can delete it. Hack
does not remove it on the next write, because another write may still be using it. The
rename has these effects:

- a symlinked env file keeps its link; the new contents land at the file the link points
  to, and the staging file is created next to that file
- a symlink whose target does not exist is replaced by a regular file
- a hard link is broken: the env file gets a new inode, and any other name for the old
  file keeps the previous contents
- the directory must be writable, even when the env file itself is writable; if it is
  not (for example a `.hack` directory at mode `0555`), Hack refuses with a one-line
  error that names the env file and says its directory is not writable

A rename does not need write access to the file it replaces, so Hack checks that access
itself before it stages anything. It refuses to replace an existing env file that it
cannot read, that is not a regular file, that is not writable, or whose owner and group
it cannot keep (for example a root-owned file left by an earlier `sudo hack`). `hack env
unset` refuses an env file it cannot read in the same way, rather than reporting that
there is nothing to remove. The error is one line under every `HACK_LOGGER` backend
(`HACK_DEBUG=1` adds the stack), names the file and the reason, never a value, and the
file is left as it was. Fix the file's permissions or ownership and run the command
again. A rewrite keeps the file's permission bits, owner and group.

This includes a file you own whose group you are not a member of. Without root, the new
file cannot be given that group, so Hack refuses rather than let the file fall back to
your default group: keeping group-readable permission bits under a different group could let other
accounts read it (on macOS the default group is usually `staff`, which every local
account belongs to). Such a file usually comes from moving it (`mv`) out of a directory
with another group, for example `/tmp` on macOS, where new files take the directory's
group `wheel`, or from being removed from the file's group. Run `chgrp <your-group>
<file>` and run the command again.

The other files these commands write fail the same way. These are `.hack/.gitignore`
(`--local` and `hydrate`), `.hack.secret.key` (the first `--secret` value, including
the key lock Hack takes in the git directory first), the repository root `.gitignore`
entry for that key, and `.hack/.internal/` (the `hydrate` lock). If a write is denied,
the filesystem is read-only, the disk or quota is full, a parent path is not a
directory, or a directory is in the way of a file, Hack prints one line. That line
names the file or directory Hack was writing, gives the reason and says what to fix. It
never shows the raw system error, the hidden staging file name or the lock's staging
file. An env file on a read-only filesystem is reported as a read-only filesystem, not
as a file that is not writable.

Each of these lines starts with a stable code, and `--json` puts the same code and
message in the envelope:

- `E_PERMISSION`: permission denied, a read-only filesystem, or an owner or group Hack
  cannot keep. A `.hack` directory you cannot search (for example mode `0644`) and one
  you cannot write (for example mode `0555`) both give this code.
- `E_NO_SPACE`: the disk or the disk quota is full.
- `E_PATH_CONFLICT`: a path is the wrong kind of entry, such as a file where Hack needs
  a directory, or a directory where Hack needs a file.

If you omit `key`, `value`, or `--service`, `hack env add` prompts for them interactively.
Pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) for scripted/agent usage: the
command applies documented defaults or fails fast with `E_INTERACTIVE_REQUIRED` instead of
blocking on a prompt. In scripts, supply secret values with `--value-stdin` rather than as
arguments. `hack env unset` and `hack env set` accept `--local` and
`--no-interactive` too.

Remove a value:

```bash
hack env unset API_BASE_URL
hack env unset SERVICE_TOKEN --service api --env qa
hack env unset API_BASE_URL --local
```

### Hydrate machine-local values in one step

`hack env hydrate` imports many values into the machine-local layer at once, for example
when a new checkout or machine pulls its secrets from a secret manager. Tracked defaults
stay in `hack.env.default.yaml`; hydration writes only the gitignored local layer
(`.hack/hack.env.local.yaml`, or `.hack/hack.env.<overlay>.local.yaml` with `--env`).

```bash
# Pipe KEY=value lines from a secret manager; values never appear in argv.
<secret-source> | hack env hydrate --secret

# Or read a file, or a pipe such as <(secret-source).
hack env hydrate --secret --file .secrets.env
hack env hydrate --secret --file secrets.json --format json --env qa --service api
```

Input comes only from piped stdin or `--file`, never from arguments, and is at most
1 MiB. The default `env` format is strict, one entry per line:

- blank lines and lines starting with `#` are skipped, and an `export ` prefix is allowed
- `KEY=value`, where the key matches `^[A-Z_][A-Z0-9_]*$`; an unquoted value is the
  rest of the line with surrounding spaces removed, and `#` inside it is part of the value
- `'...'` is literal; `"..."` accepts `\n`, `\r`, `\t`, `\"` and `\\`; a quoted value
  must close on the same line, followed only by spaces or a `# comment`
- empty values, repeated keys and `${VAR}` expansion are not supported

`--format json` takes one object whose values are non-empty strings. A key that
appears twice is refused, as in the `env` format; it is not resolved by keeping the
last value. One malformed entry refuses the whole input. The message gives only the line number, never the
line, and nothing is written.

`--secret` encrypts every imported value; without it the values are stored as plain
entries in the local layer. A plain import refuses to replace a key that the local
layer already stores as a secret, so repeat an import with the same flags it was first
run with. `--service` picks one scope for all entries (default
`global`). The output and `--json` result list the added, updated and unchanged keys,
never values.

Hydration is idempotent and all-or-nothing:

- An entry that already holds its value is left alone: a secret keeps its ciphertext
  and a plain number keeps its YAML type. When nothing changes, the file is not
  rewritten, so comments and formatting survive and Git shows no change.
- A changed value gets new ciphertext with a fresh IV.
- Local entries that are not in the input, other scopes, and removal markers for other
  keys are kept. A key in the input replaces that key's local entry, including a
  value you set by hand with `--local`.
- The whole new layer is written to a staging file and published by one rename, so an
  interrupted hydration leaves the previous layer, with every key at its old value.

Hydration refuses, without changing the layer, when:

- git tracks the target local layer
- the project is in a git checkout but git cannot say whether it tracks the local layer,
  for example after a `safe.directory` refusal, with a damaged index, or with git not
  installed (outside any git checkout, hydration proceeds)
- the local layer exists but is not a valid env file, for example invalid YAML, the
  wrong `version`, or a scope that is not a mapping; fix or remove it first
- a secret already in the local layer does not decrypt under the project env key, or no
  key is available (`.hack.secret.key` is used before `HACK_ENV_SECRET_KEY`, as when
  values are read)
- `--secret` is used, no `.hack.secret.key` exists, and `HACK_ENV_SECRET_KEY` is set
  (a new key file would replace that key for every layer)
- `--secret` is not used and an imported key is stored as a secret in the target scope;
  re-run with `--secret`, or remove the key with `hack env unset <key> --local` first
- another `hack env hydrate` for the same project is running, or an interrupted one left
  a stale lock (see below)
- the local layer changed between hydration's read and its rename, for example from a
  concurrent `hack env set --local`

Concurrent hydrations are serialized by `.hack/.internal/env-hydrate.lock`, which holds
the owner's process ID. A hydration that is killed (for example with SIGKILL) cannot
remove it; the next hydration then reports the stale lock and its path instead of taking
it over. Remove the file once no hydration is running. `hack env set --local` does not
take this lock. Hydration checks the layer again just before its rename, which narrows
the window in which such a write could be overwritten but cannot close it.

Materialize a compatibility `.hack/.env`:

```bash
hack env materialize
hack env materialize --env qa
hack env materialize --env qa --service api
```

Run a host command with injected env:

```bash
hack host exec -- bun db:migrate
hack host exec --env qa --scope api -- bun db:migrate
hack host exec --env qa --scope api --target compose -- bun test
```

Cancelling `hack host exec` or `hack env exec` with SIGINT or SIGTERM forwards
the signal to the command. Commands run in an owned process group,
so cancellation also stops their descendants, escalating to SIGKILL after two
seconds if necessary. Hack returns 130 for SIGINT and 143 for SIGTERM. Interactive
commands use a supervisor in their own foreground group on the same terminal,
preserving stdin, separate output streams, and Ctrl-Z/foreground resume. Piped
stdin also retains the controlling terminal, so commands can open `/dev/tty`
for native authentication prompts. The
supervisor holds group ownership until cancellation cleanup finishes. SIGKILL cannot be forwarded; supervisors must terminate the
whole owned process tree when force-killing a wrapper. Commands have no implicit
time limit, and normal completion preserves the command's exit status.

When you want to inspect an injected value, avoid `hack host exec -- echo $VAR`. Your current
shell expands `$VAR` before Hack starts the child process, so the command often sees an empty
string.

Use one of these instead:

```bash
hack host exec -- printenv APPLE_TEAM_ID
hack host exec -- sh -lc 'printf "%s\n" "$APPLE_TEAM_ID"'
hack host exec --shell 'echo $APPLE_TEAM_ID'
```

Open a host shell with injected env:

```bash
hack host shell
hack host shell --env qa --scope api
hack host shell --env qa --scope api --target compose
```

Example with an explicit host override:

```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global:
    DATABASE_URL:
      secure: v1:...
    REDISHOST: redis
  host:
    REDISHOST: "127.0.0.1"
```

## Sessions and env

Session flows can now carry env selection too.

Examples:

```bash
hack session start my-project --env qa --service api --detach
hack session exec my-project.env-qa.svc-api --env qa --service api "bun db:migrate"
```

When you pass `--env` or `--service`, Hack creates a stable scoped workspace name instead of reusing the plain default workspace. That prevents one shell from silently inheriting the wrong env selection.

## Secret key handling

Secret values in the YAML files are encrypted with the project key.
The [env and secrets threat model](security/env-secrets-threat-model.md) lists what
this protects against and the gaps that are still open.

Default behavior:

- generate `.hack.secret.key` the first time you add a secret
- add `.hack.secret.key` to `.gitignore`
- decrypt secrets from `.hack.secret.key` on the local machine
- linked git worktrees can reuse the primary checkout's `.hack.secret.key` when the worktree copy is missing

Linked worktree behavior:

- when a repo uses linked git worktrees, Hack prefers a shared key under the git common dir
- sibling worktrees can decrypt the same committed secrets without manually copying gitignored files
- if a checkout-local `.hack.secret.key` exists, it still wins for that checkout
- `hack up` in a linked worktree auto-selects a branch instance (`worktree.auto_branch`); that
  selection determines which instance's resolved env is the one actually injected, so keep the
  key readable from every checkout that runs `hack up`

Linked worktrees also read the primary checkout's eligible local YAML overrides
(`hack.env.local.yaml`, or its legacy-compatible local-default path, and the selected
`hack.env.<overlay>.local.yaml`). Resolution order is checkout tracked default and
overlay, primary local default and overlay, then checkout local default and overlay.
The resolved file list includes inherited paths. Primary tracked configuration,
legacy `.env`, runtime state and unrelated ignored files are not inherited.

Local values override inherited values. A YAML `null` entry explicitly removes a
value supplied by earlier layers; deleting the entry instead reveals the earlier
value again. `hack env unset KEY --local` in an inheriting linked worktree records
that removal without modifying the primary file. A later `set --local` replaces it.
Inheritance reads current files each time and never copies them into the worktree.
Invalid inherited files and redirected file paths fail explicitly.

Set `worktree.inherit_local: false` in the checkout's Hack config to disable local
file inheritance. CI (`CI=1` or `CI=true`) and slim/Codex execution mode disable it
automatically. This setting does not change the existing secret-key lookup order
below. Missing primary local files are optional; retained encrypted values still
require the selected checkout's valid decryption key.

Full read order for decrypting secrets (first match wins):

1. checkout-local `.hack.secret.key`
2. shared key under the git common dir
3. the primary checkout's key, inherited automatically for a linked worktree that has neither of the above
4. `HACK_ENV_SECRET_KEY`

Write-path guarantees in a linked worktree (first secret added from any checkout):

- an existing checkout-local key is reused as-is
- otherwise an existing shared key (git common dir) is reused
- otherwise the primary checkout's key is adopted by copying it to the shared location, so sibling checkouts converge on one key
- only then is a new key generated, and it is written to the shared location — never silently to the checkout
- concurrent first use from several checkouts converges on one key: when no key exists, creation runs under a cooperative lock at `<git common dir>/.hack.secret.key.lock`, and a key file is published only when complete, never empty or partial (Hack v4 writers do not take the lock)
- if the shared location cannot be resolved (git unavailable) or written, Hack falls back to a checkout-local key and prints a loud divergence warning
- `hack doctor` flags divergent `.hack.secret.key` contents across checkouts with the exact paths

Key strength and exposure (`hack doctor` "env key" check):

`hack doctor` and `hack doctor --json` audit the checkout-local key, the shared key
under the git common dir and, in a linked worktree, the primary checkout's key. When
no key file exists, the check classifies `HACK_ENV_SECRET_KEY` instead. The check is
read-only. It never prints key bytes or absolute paths, and `--fix` does not act on it.
Each finding names a project-relative subject and the exact command to run from the
project root. `--json` adds an `envKey` object to the check with `status` and
`findings` (`code`, `status`, `subject`, `remedy`). The native runtime backend's
`hack doctor` runs the same check inside a project.

Nested public artifact directories are found with a bounded walk from the project
root: at most six levels deep, 4096 directories and 100,000 entries. It skips
`node_modules` and `.git`, does not follow symlinked directories, and reports a path
it cannot spell portably as `<unprintable-path>/.hack.secret.key`.

| Code | Status | Meaning |
| --- | --- | --- |
| `env-key-ok` | ok | key material is a regular, private, 256-bit-class file |
| `env-key-absent` | ok | no key file and no `HACK_ENV_SECRET_KEY` |
| `env-key-weak-permissions` | warn | group or others have access; suggests `chmod 600` |
| `env-key-wrong-owner` | warn | the file is not owned by the current user |
| `env-key-wrong-length` | warn | shorter than the 43-character base64url form of a 256-bit key, or empty |
| `env-key-low-entropy` | warn | long enough but repetitive (estimated under 128 bits) |
| `env-key-symlink` | error | the key path is a symlink; Hack refuses symlinked keys |
| `env-key-not-regular` | error | the key path is a directory or another non-file entry |
| `env-key-unreadable` | error | unreadable, oversized or not UTF-8 |
| `env-key-tracked` | error | a file named `.hack.secret.key` is tracked by git at any depth |
| `env-key-public-path` | error | a key copy sits directly in `public/`, `static/`, `dist/`, `build/`, `out/`, `www/`, `_site/`, `.next/` or `.output/`, at the project root or in a nested package such as `apps/web/public/` |

Hack derives the AES-256-GCM key by hashing the key text with SHA-256, so key
strength is the entropy of that text. Generated keys are 32 random bytes in base64url.
For a weak, tracked or published key, rotation is required. Preserve a private,
recoverable copy of the old key and encrypted inputs before changing either.
Recover each selected secret with the old key, then re-add it with the new key
using the hidden prompt or `--value-stdin`; never put secret values in arguments.
Individual atomic writes do not make this sequence a crash-safe rotation transaction.
See the [env security decision and rotation gates](security/env-secrets.md).

CI and managed container fallback:

- if `.hack.secret.key` is missing, Hack falls back to `HACK_ENV_SECRET_KEY`

That makes this model usable in CI and portable container images without committing the key file.

Published container paths:

- slim managed-container base: `hackdance/hack:slim` — the supported CI / managed-container story
- full remote runtime: `hackdance/hack:latest` — serves the remote/node surface, which is
  experimental and unsupported (hidden behind `hack help --all`); only relevant if you have
  explicitly opted into that surface

In both cases, inject `HACK_ENV_SECRET_KEY` from the runtime or secret manager instead of copying
`.hack.secret.key` into the image.

## Legacy repos and migration

Older repos may still have:

- `.hack/hack.env.json`
- `.hack/.env`
- `.hack/.env.<overlay>`
- configured secret backends via `hack env backend`

Hack still detects and reads that legacy format, but the preferred migration path is:

```bash
hack doctor --migrate-env-config
```

That migrates the repo into:

- `.hack/hack.env.default.yaml`
- `.hack/hack.env.<overlay>.yaml`
- `.hack.secret.key` when needed

`hack doctor` also warns when a repo still depends on the old format.
For modern env repos, `hack doctor` also warns when materialized compatibility output in
`.hack/.env` or `.hack/.env.state.json` is stale and points to `hack env materialize`.

## Compatibility notes

The modern YAML env model is the canonical repo format today.

Some older surfaces are still compatibility-oriented:

- `hack env backend ...` remains relevant for legacy repos and older secret-store configurations.
  The `encrypted_file` store (also used by the `cloud` shim) is replaced atomically
  with mode `0600`, and set/delete hold an in-process queue plus a cooperative
  `<store>.lock` so concurrent writers, including separate processes, do not lose
  updates. A store path that is a symlink is refused for writes. Explicit key
  provisioning also uses an atomic mode-`0600` replacement and refuses symlinked
  key paths or immediate parent directories. A key generated on first use is
  published only when no key file exists, so concurrent first users adopt the key
  published first instead of replacing it under a store already encrypted with
  it. This protects individual key writes;
  it does not make key replacement and store re-encryption a crash-safe rotation
  transaction. Keep the previous key until recovery has been verified. The v1 store
  envelope and legacy `v1:` values authenticate no associated data: they are not
  bound to a path, project or variable name beyond the scoped key inside the
  encrypted store plaintext
- the daemon's env HTTP route (used by the macOS app) reads and writes the legacy dotenv-shaped
  contract (`source: 'plain_env'|'keychain'`, `resolvedFrom: 'dotenv'/'process'/'keychain'/'portable_backend'`),
  not the modern YAML `hack env list --json` shape; there is no web dashboard surface anymore

If you are writing new docs or new project setup flows, document the YAML overlay model first and treat `.hack/hack.env.json` as legacy migration context.

## Recommended project policy

- Commit `.hack/hack.env.default.yaml`
- Commit `.hack/hack.env.<overlay>.yaml` when the overlay is team-shared
- Never commit `.hack.secret.key`
- Prefer `hack env add` over hand-editing encrypted values
- Enter secrets with `--value-stdin` or the hidden prompt, never as command arguments
- Prefer direct runtime injection over materializing `.hack/.env`
- Use `hack host exec` or env-aware sessions for host-side scripts like migrations, generators, and admin tasks

## Related docs

- [Initialize a project](guides/init-project.md)
- [Sessions](sessions.md)
- [CLI reference](cli.md)
- [Env and secrets threat model](security/env-secrets-threat-model.md): assets, trust boundaries, current mitigations and open gaps
- [Env secret security decision and rotation gates](security/env-secrets.md)


### Host command lifetime and diagnostics

`hack host exec` and `hack env exec` record payload-free execution metadata under
`$HACK_HOME/host-commands` (normally `~/.hack/host-commands`). Records contain the
executable basename, project, process identities, owned process group, intended
lifetime, elapsed time, exit/cancellation/timeout outcome, and final child CPU/RSS
accounting. Arguments, shell strings, environment values and command output are
not recorded. Completed records expire after seven days during later executions;
interrupted records remain available for review. A diagnostic storage failure
warns on stderr and preserves command execution and exit status.

```sh
hack host exec --timeout 60 -- bun scripts/check.ts </dev/null
hack env exec --timeout 30 -- bun scripts/probe.ts </dev/null
hack host exec --lifetime persistent -- bun run dev
hack host ps --json
hack host ps --project my-project
```

`--timeout` is a positive number of seconds. It sends SIGTERM to the owned process
group, escalates after two seconds, and returns 124. It currently requires
non-TTY stdin; piping input or redirecting from `/dev/null` preserves a safe group
boundary without changing interactive terminal job control. There is no default
timeout. `--lifetime persistent` declares intent and does not detach or create a
mux session; it cannot be combined with a timeout. Persistent commands still
respond to explicit cancellation. Use lifecycle processes or `hack session` for
managed persistent workspaces.

`hack host ps` also inspects existing lifecycle sessions using their stored mux
ownership evidence. It is read-only: missing wrappers and unverified groups are
reported for review and never killed. A PID must match its recorded start time
before live command metrics are attributed to it. Lifecycle definition freshness
is not revalidated by this resource snapshot. Commands started before tracking was
available cannot be retroactively assigned ownership.

Live CPU time is the cumulative CPU of currently observed tree/group members;
short-lived descendants already gone are not included. Final CPU comes from the
OS-reaped child resource usage and is a separate accounting source. RSS sums may
count shared memory more than once. Missing observations are null, not zero.
SIGKILL cannot be intercepted: interrupted records may lack a completion result,
and group members without a surviving identity are explicitly unverified.

See [runtime performance diagnostics](performance.md) for project-listing timings,
container details, watcher measurements and read-only cleanup previews.
