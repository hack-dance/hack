# Pulumi-Style Env Config Design

## Goal

Replace the current split env model with a simpler portable model that behaves like Pulumi stack config:

- one committed per-overlay config file is the canonical source of truth
- plaintext and encrypted values live side-by-side in that file
- runtime injection reads directly from canonical config by default
- local `.env` files are optional generated compatibility outputs, never canonical inputs
- overlay selection is by filename convention and simple merge order

This is the recommended successor to the current `.hack/hack.env.json` + `.hack/.env` + secret-backend split.

## Problem

The current Hack env model mixes too many responsibilities:

- `.hack/hack.env.json` is a committed contract
- `.hack/.env` may hold plaintext local values
- the configured backend may hold secrets
- `storePlaintextInBackend=true` can make the backend the portable source of truth
- overlays partly live in plaintext files and partly in backend-scoped values

That model is powerful, but the product shape is hard to explain. Users do not have one obvious answer to:

- Where do I look for the real value?
- What should I commit?
- What should I hand off to another engineer?
- What regenerates `.hack/.env`?
- What does `--env=qa` actually mean on disk?

Pulumi’s model is simpler because the user sees one stack config file, one config map, and one obvious secret representation.

## Decision

Adopt a Pulumi-style committed env config model and phase out the current contract/source/backend model as the default.

This design:

- replaces `.hack/hack.env.json` as the primary user-facing env artifact
- removes `source` from per-key config
- keeps service scoping, but in a much simpler file shape
- treats `.hack/.env` as generated output only when explicitly requested
- makes overlays file-based by convention instead of split across contract + plaintext + backend state

## Canonical Files

Canonical env files live at repo root:

- `hack.env.default.yaml`
- `hack.env.<overlay>.yaml`

Examples:

- `hack.env.default.yaml`
- `hack.env.qa.yaml`
- `hack.env.prod.yaml`
- `hack.env.docker.yaml`

`default` is special:

- it always acts as the base layer
- it is loaded even when another overlay is selected

Overlay merge behavior:

1. load `hack.env.default.yaml`
2. if `--env=<name>` is set, load `hack.env.<name>.yaml`
3. selected overlay keys replace default keys

If a project wants a non-empty ambient overlay, use project config:

```json
{
  "env": {
    "defaultOverlay": "docker"
  }
}
```

This setting belongs under `env`, not `secrets`, because overlay selection is not a secret-backend concern.

## File Format

Use YAML.

Reasons:

- it matches the Pulumi mental model directly
- it is easier to read and hand-edit than JSON
- it handles mixed scalar values and `{ secure: ... }` blocks cleanly
- comments are useful for local config files

Do not use TOML for v1:

- inline object ergonomics are worse for mixed plain and encrypted values
- nested secret objects are less visually obvious
- Pulumi parity is lower

Do not use JSON for v1:

- it is noisier to edit
- comments are unavailable
- it does not help readability enough to justify the tradeoff

### Proposed Shape

```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global:
    IS_LOCAL: "true"
    API_BASE_URL: https://api.example.com
  api:
    SERVICE_TOKEN:
      secure: v1:...
```

### Value Rules

- Plaintext values are YAML scalars under `values.<scope>.<KEY>`.
- Secret values are objects with a single `secure` field under `values.<scope>.<KEY>`.
- `global` is the shared base scope for all services.
- other scopes map to Hack service names such as `api`, `web`, or `worker`
- Keys are flat env var names. No per-key `source` field.
- Keys are opaque strings. Hack does not require namespace prefixes.
- Structured values are out of scope for v1. Env config is a flat key-value map.
- A service receives `global` values plus its own service-scoped values.

### Top-Level Fields

- `version`: schema version. Start at `1`.
- `environment`: overlay name. `default` for the base file, `qa` for `hack.env.qa.yaml`, and so on.
- `secretsprovider`: how `secure` values are encrypted. Start with `project_key`.
- `values`: map of scopes to flat key-value env maps.

### Not In V1

Do not include these in the initial schema:

- `source`
- required/optional metadata
- descriptions
- deep nested config objects
- multiple secret providers per file

Those features made the old model harder to explain. If they return later, they should be additive and clearly justified.

## Runtime Injection And Materialization

Canonical config files are the default runtime source. Hack resolves them in memory and injects the effective env directly into services and commands.

Primary runtime behavior:

- `hack up` injects resolved env into each service without requiring `.hack/.env`
- `hack run <service> ...` injects `global` plus that service's scoped values
- `hack run --service=<name>` or equivalent service-aware flows should validate that the named service exists
- unknown service scopes should trigger a warning in `hack env status` and `hack doctor`

Optional generated output:

- `.hack/.env`

Behavior:

- `hack env materialize` is manual, not automatic
- `hack env materialize` writes a compatibility `.hack/.env` for the selected service or for the global merged view
- `hack env materialize --env=qa` reads `hack.env.default.yaml` plus `hack.env.qa.yaml`
- `hack env materialize --service=api` writes the effective env for one service
- secret values are decrypted before writing `.hack/.env`

This keeps the product simple:

In the new model:

- `.hack/.env` is optional
- `.hack/.env` is always gitignored
- runtime injection does not depend on materialization
- there is no second local canonical secret store by default

If future platform integrations still need OS-backed secret storage, that should be an optional secondary feature, not the primary user model.

## Project Secret Key

Start with a generated project-local key file instead of passphrase-first UX.

Default location:

- `.hack.secret.key`

Rules:

- generated automatically the first time a secret is added
- stored at repo root by default
- never committed
- automatically appended to `.gitignore` if missing

The first secret-writing flow should do all of this for the user:

1. generate `.hack.secret.key` if absent
2. verify `.gitignore` contains `.hack.secret.key`
3. encrypt the secret value
4. write the updated `hack.env.<overlay>.yaml`

This is simpler than requiring passphrase setup before the user can store a secret.

### Provider model

V1 provider:

- `secretsprovider: project_key`

Future providers can be added later:

- `passphrase`
- `age`
- cloud KMS
- team-managed broker storage

But the default local UX should be key-file based because it minimizes prompts and keeps the happy path simple.

## Materialization Tracking

Hack should track whether `.hack/.env` is stale relative to the selected canonical config files.

Recommended generated metadata file:

- `.hack/.env.state.json`

Suggested contents:

```json
{
  "version": 1,
  "selectedOverlay": "qa",
  "inputs": {
    "default": "sha256:...",
    "overlay": "sha256:..."
  },
  "generatedAt": "2026-03-27T16:00:00.000Z"
}
```

This enables:

- explicit drift detection
- clear status output
- explicit rematerialization when users ask for compatibility output

## CLI Surface

### Core commands

- `hack env materialize`
- `hack env materialize --env=<name>`
- `hack env materialize --service=<name>`
- `hack env status`
- `hack env add`
- `hack env add KEY VALUE`
- `hack env add KEY VALUE --service=<name> --secret`
- `hack env unset KEY`

`hack env set` can remain as an alias for compatibility, but `add` should become the primary UX because it reads better in both flag-driven and interactive flows.

### Command semantics

`hack env materialize`

- resolves `default` plus the selected overlay
- writes `.hack/.env`
- updates `.hack/.env.state.json`
- prints whether materialization changed anything

`hack env materialize --service=<name>`

- resolves `global` plus the requested service scope
- warns if the service name does not exist in the current project
- writes a compatibility output for tooling that still expects a flat env file

`hack env add`

- updates the canonical YAML file, not `.hack/.env`
- defaults to `hack.env.default.yaml`
- supports `--env=<name>` to target an overlay file
- supports `--service=<name>` to target `values.<name>`
- supports `--secret` for encrypted values
- does not materialize automatically

Suggested non-interactive forms:

```bash
hack env add API_BASE_URL https://api.example.com
hack env add SERVICE_TOKEN abc123 --service=public-api --secret
hack env add global.API_BASE_URL https://api.example.com
```

Preferred parsing rules:

- `hack env add KEY VALUE` targets `global` by default
- `--service=<name>` overrides the target scope
- dotted `global.KEY` or `api.KEY` syntax is accepted as a convenience form
- if both dotted scope syntax and `--service` are provided, that is an error

### Interactive add flow

`hack env add` with no positional args should open an interactive flow using Clack.

Recommended prompts:

1. choose kind
   - plaintext
   - secret
2. choose target service
   - `global`
   - discovered project services
3. enter key name
4. enter value
5. confirm target file and overlay

Behavior:

- service choices should be discovered from the current project and shown directly
- unknown service entry should still be possible through a manual fallback path
- selecting `secret` should auto-generate `.hack.secret.key` if needed
- the command should print exactly which file and scope changed

`hack env status`

- shows:
  - selected overlay
  - canonical file paths
  - known service names discovered from the project
  - unknown service scopes declared in env config
  - whether `.hack/.env` exists
  - whether `.hack/.env` is stale
  - whether the env file is currently unlocked

### Runtime behavior

These commands should resolve and inject env directly from the canonical config:

- `hack up`
- `hack run`
- `hack restart`
- `hack env list`

They should not auto-write `.hack/.env`.

### Service discovery and validation

Hack should maintain a discovered set of service names from the current project.

Sources may include:

- `.hack/docker-compose.yml`
- other Hack-managed service definitions

Validation behavior:

- `global` is always valid
- known services are valid
- unknown scopes should warn in `hack env add`, `hack env status`, and `hack doctor`
- startup should warn if an env file references unknown service scopes
- warnings should not block users from creating scopes early for services that are about to be added

## Encryption Model

Start with project-key encryption.

V1 rules:

- `secretsprovider: project_key`
- secret values are encrypted with `.hack.secret.key`
- the key is generated automatically on first secret write
- the key file is gitignored automatically if missing from `.gitignore`

Why start with a project key:

- no initial passphrase ceremony
- fewer prompts during normal CLI use
- easier onboarding story for local-first projects
- still portable when the key is shared intentionally out of band

Future providers can be added later without changing the canonical file shape.

## Schema

Add a JSON Schema for editor validation:

- `schemas.hack/hack.env.config.schema.json`

Schema rules:

- top-level object
- required: `version`, `environment`, `secretsprovider`, `values`
- `secretsprovider` enum initially includes `project_key`
- `values` must contain `global`
- scope keys must be `global` or service-name-safe identifiers
- each env key must match env-var-safe key syntax
- each env value must be:
  - scalar string, number, or boolean
  - or `{ "secure": "<ciphertext>" }`

The YAML file stays the user-facing source, but JSON Schema gives editor support and validation without changing the file format.

## Migration

Add doctor-assisted migration for older repos.

### Command

- `hack doctor --migrate-env-config`

### Migration input

Read from the current model:

- `.hack/hack.env.json`
- `.hack/.env`
- `.hack/.env.<overlay>`
- configured secret backend
- env-scoped backend secret values
- existing project service names for scope validation

### Migration output

Produce:

- `hack.env.default.yaml`
- `hack.env.<overlay>.yaml` for each discovered overlay
- optional `.hack/.env` if the operator asks for materialization during migration
- `.hack/.env.state.json`
- `.hack.secret.key` when migrated secrets need a new local encryption key

### Migration behavior

1. infer `default` from current base values
2. infer overlays from `.hack/.env.<name>` and env-scoped backend values
3. map repo-wide values into `values.global`
4. map service-specific values into `values.<service>` when the legacy metadata makes that unambiguous
5. convert secret-backed values into `secure:` entries
6. generate `.hack.secret.key` if secret values are present and no project key exists yet
7. write the new YAML files
8. optionally materialize `.hack/.env`
9. print a cleanup plan for deprecated files and config

### Deprecated after migration

- `.hack/hack.env.json`
- `controlPlane.secrets.storePlaintextInBackend`
- repo-relative encrypted-file bundle as the primary env UX
- per-key `source`
- per-key service scoping in env config

## Simplified Project Config

Project config should be reduced to:

```json
{
  "env": {
    "defaultOverlay": "docker"
  }
}
```

That is enough for default overlay selection.

Do not require project config for:

- declaring keys
- choosing plaintext vs secret per key

Project config may still help with:

- service discovery hints when static detection is ambiguous
- validation policy for unknown service scopes
- choosing the default overlay
- choosing a non-default project secret key path in advanced setups

Those concerns either belong in the canonical env files or should stay out of the initial product.

## Why This Is Better

- One obvious place to look for values.
- One obvious committed artifact per overlay.
- One obvious secret representation.
- One obvious merge rule.
- One obvious materialization command.
- Fewer repo-specific docs are needed to explain onboarding.

Most importantly, it aligns the product with the model users already understand from Pulumi instead of forcing them to learn a Hack-specific split-brain env system.

## Recommended Rollout

### Phase 1

- land the schema and parser for `hack.env.<overlay>.yaml`
- add `hack env materialize`
- add `hack env status`
- add `hack env set` support for the new file format
- wire `hack up` and `hack run` to inject canonical env directly

### Phase 2

- add `hack doctor --migrate-env-config`
- keep old files readable but deprecated
- warn when repos still depend on the legacy split model

### Phase 3

- remove legacy contract-first scaffolding from `hack init`
- make Pulumi-style env config the default for new repos
- keep broker/KMS integrations as advanced provider options, not baseline UX
