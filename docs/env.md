# Env & secrets

Hack now uses repo-level env overlay files as the canonical project env model.

The short version:

- commit `hack.env.default.yaml`
- optionally commit `hack.env.<overlay>.yaml`
- keep `.hack.secret.key` out of git, or provide `HACK_ENV_SECRET_KEY`
- let `hack up`, `hack run`, `hack restart`, `hack env exec`, `hack env shell`, and env-aware session flows inject values directly at runtime
- use `hack env materialize` only when you explicitly need a compatibility `.hack/.env`

## Current model

Canonical env state lives at the repo root:

- `hack.env.default.yaml`
- `hack.env.<overlay>.yaml`

Compatibility and local-only state still lives under `.hack/`:

- `.hack/.env`
- `.hack/.env.state.json`
- `.hack/.internal/...`

Encryption key material is local-only by default:

- `.hack.secret.key`
- or `HACK_ENV_SECRET_KEY`

`hack init` now scaffolds `hack.env.default.yaml` by default.

## File format

Each env file is YAML with:

- `version: 1`
- `environment`
- `secretsprovider: project_key`
- `values`

`values` is split by scope:

- `global`: values applied everywhere
- `<service>`: values applied only for that compose service

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

1. load `hack.env.default.yaml`
2. if `--env=<name>` is selected, load `hack.env.<name>.yaml`
3. merge `values.global`
4. if a service scope is requested, merge `values.<service>` on top

Overlay values override default values. Service values override global values.

Projects can set a default overlay in `.hack/hack.config.json`:

```json
{
  "env": {
    "defaultOverlay": "qa"
  }
}
```

Use `--env=base` to bypass that default and read only `hack.env.default.yaml`.

## Runtime behavior

Direct runtime injection is the default path.

Hack reads the canonical YAML files and injects the resolved env directly into:

- `hack up`
- `hack run`
- `hack restart`
- lifecycle host processes
- `hack env exec`
- `hack env shell`
- `hack session start --env ... --service ...`
- `hack session exec --env ... --service ...`

That means `.hack/.env` is no longer the primary runtime source of truth.

`hack env materialize` is manual by design. Use it only when you need a compatibility file for an external tool that expects `.env` on disk.

## Common commands

Inspect resolved env:

```bash
hack env list
hack env list --env qa
hack env list --env qa --service api
hack env list --json
```

Add or update values:

```bash
hack env add API_BASE_URL https://api.example.com
hack env add SERVICE_TOKEN abc123 --service api --secret
hack env add --env qa API_BASE_URL https://qa.example.com
```

`hack env set` still works as a compatibility alias for `hack env add`, but `add` is the primary UX now.

Remove a value:

```bash
hack env unset API_BASE_URL
hack env unset SERVICE_TOKEN --service api --env qa
```

Materialize a compatibility `.hack/.env`:

```bash
hack env materialize
hack env materialize --env qa
hack env materialize --env qa --service api
```

Run a host command with injected env:

```bash
hack env exec -- bun db:migrate
hack env exec --env qa --service api -- bun db:migrate
```

Open a host shell with injected env:

```bash
hack env shell
hack env shell --env qa --service api
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

CI and managed container fallback:

- if `.hack.secret.key` is missing, Hack falls back to `HACK_ENV_SECRET_KEY`

That makes this model usable in CI without committing the key file.

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

- `hack.env.default.yaml`
- `hack.env.<overlay>.yaml`
- `.hack.secret.key` when needed

`hack doctor` also warns when a repo still depends on the old format.

## Compatibility notes

The modern YAML env model is the canonical repo format today.

Some older surfaces are still compatibility-oriented:

- `hack env backend ...` remains relevant for legacy repos and older secret-store configurations
- daemon/UI mutation routes are still catching up to the modern YAML write path
- browser/app read surfaces already understand the new `hack env list --json` payload

If you are writing new docs or new project setup flows, document the YAML overlay model first and treat `.hack/hack.env.json` as legacy migration context.

## Recommended project policy

- Commit `hack.env.default.yaml`
- Commit `hack.env.<overlay>.yaml` when the overlay is team-shared
- Never commit `.hack.secret.key`
- Prefer `hack env add` over hand-editing encrypted values
- Prefer direct runtime injection over materializing `.hack/.env`
- Use `hack env exec` or env-aware sessions for host-side scripts like migrations, generators, and admin tasks

## Related docs

- [Initialize a project](guides/init-project.md)
- [Sessions](sessions.md)
- [CLI reference](cli.md)
- [Pulumi-style env config design](plans/2026-03-27-pulumi-style-env-config-design.md)
