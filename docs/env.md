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

How it is maintained:

- written by `hack init`, and self-healed by `hack up` and whenever hack
  writes `.hack/.internal/` overrides or `--local` env overrides
- the entries live inside a marked, hack-managed block; anything you add
  outside the markers is preserved on every rewrite
- the root `.gitignore` still gets a `.hack.secret.key` entry when the secret
  key is first generated (the key lives at the repo root, not under `.hack/`)
- older repos that added `.hack/.internal/` to the root `.gitignore` keep
  working; the entries are equivalent and nothing is removed

Leak detection and repair:

- `hack doctor` runs a "generated files" check: it lists any of the paths
  above (plus `.hack.secret.key`) that are tracked in git, except a tracked
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

Use `--env=base` to bypass that default and read only `.hack/hack.env.default.yaml`.

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

`hack env materialize` is manual by design. Use it only when you need a compatibility file for an external tool that expects `.env` on disk.

For host execution, `hack host exec`, `hack host shell`, and lifecycle hooks/processes use a host-local view.
That means Hack prefers host-usable values when it can:

- explicit `host` scope values override the normal `global` + `<service>` merge
- common container-only hostnames such as `host.docker.internal` and compose service hosts are rewritten to `127.0.0.1`

Use `--target compose` if you explicitly want the container-oriented compose view instead.

## Choosing the right execution surface

- `hack host exec` / `hack host shell`: run on your host machine with Hack-resolved env injected.
- `hack run <service> ...`: run a one-off command in the compose network with an ephemeral service container.
- `hack exec <service> ...`: run inside an already-running container when you specifically need that container's live filesystem or process context.

For host execution, `--scope` means "which env scope should Hack inject", not "where should this run."
For example, `hack host exec --scope api -- bun db:migrate` still runs on the host.

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

Add or update values:

```bash
hack env add API_BASE_URL https://api.example.com
hack env add SERVICE_TOKEN abc123 --service api --secret
hack env add --env qa API_BASE_URL https://qa.example.com
hack env add API_BASE_URL https://api.example.com --local
```

`hack env set` still works as a compatibility alias for `hack env add`, but `add` is the primary UX now.

`--local` writes to the worktree-local override file (`.hack/hack.env.local.yaml` or
`.hack/hack.env.<overlay>.local.yaml`) instead of the shared repo env file — use it for
per-checkout values you don't want to commit.

If you omit `key`, `value`, or `--service`, `hack env add` prompts for them interactively.
Pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) for scripted/agent usage: the
command applies documented defaults or fails fast with `E_INTERACTIVE_REQUIRED` instead of
blocking on a prompt. `hack env unset` and `hack env set` accept `--local` and
`--no-interactive` too.

Remove a value:

```bash
hack env unset API_BASE_URL
hack env unset SERVICE_TOKEN --service api --env qa
hack env unset API_BASE_URL --local
```

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
- if the shared location cannot be resolved (git unavailable) or written, Hack falls back to a checkout-local key and prints a loud divergence warning
- `hack doctor` flags divergent `.hack.secret.key` contents across checkouts with the exact paths

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

- `hack env backend ...` remains relevant for legacy repos and older secret-store configurations
- the daemon's env HTTP route (used by the macOS app) reads and writes the legacy dotenv-shaped
  contract (`source: 'plain_env'|'keychain'`, `resolvedFrom: 'dotenv'/'process'/'keychain'/'portable_backend'`),
  not the modern YAML `hack env list --json` shape; there is no web dashboard surface anymore

If you are writing new docs or new project setup flows, document the YAML overlay model first and treat `.hack/hack.env.json` as legacy migration context.

## Recommended project policy

- Commit `.hack/hack.env.default.yaml`
- Commit `.hack/hack.env.<overlay>.yaml` when the overlay is team-shared
- Never commit `.hack.secret.key`
- Prefer `hack env add` over hand-editing encrypted values
- Prefer direct runtime injection over materializing `.hack/.env`
- Use `hack host exec` or env-aware sessions for host-side scripts like migrations, generators, and admin tasks

## Related docs

- [Initialize a project](guides/init-project.md)
- [Sessions](sessions.md)
- [CLI reference](cli.md)
- [Pulumi-style env config design](plans/2026-03-27-pulumi-style-env-config-design.md)
