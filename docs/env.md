# Env & secrets

hack supports a project-scoped env contract (shareable, no values) plus safe secret storage for local development.

## Ownership and sharing policy

Env management is separate from project ownership. A project can be shared while its env values remain
local-only.

### Sharing modes

- `local_only`: contract and values stay on the local machine
- `shared_metadata_only`: env contract metadata is shared, but values remain local
- `shared_values`: encrypted values are broker-mediated and access-controlled

### Secure-by-default rules

- New projects start with local-only env custody.
- Sharing a project must not silently share env values.
- Project access does not automatically grant env value access.
- Team membership does not automatically grant env administration.
- Shared value disclosure must be checked independently from project access.
---

## Trust model at a glance

Hack currently has three env layers, and they should be understood separately:

- Contract: `.hack/hack.env.json` defines what keys exist and how they should materialize locally.
- Local values: `.hack/.env` is the usual plaintext file for `plain_env`, and `plain_env` falls back to the current process env when `.hack/.env` does not provide a value.
- Local secrets: the configured secret backend stores secret values for keys that should not live in `.hack/.env`. In `cloud` mode today, this is still a local shim over encrypted-file storage, not a remote portable copy.

Current status:

- The contract is portable and safe to commit.
- Local values and local secrets are not automatically portable across machines.
- Remote env portability is a follow-on design, not the current default.

Planned direction:

- Portable env values will live in an immutable encrypted bundle artifact.
- Bundle access will be controlled through explicit project-key sharing.
- Applying a bundle will still write values back into `.hack/.env` and the configured local secret backend so existing runtime behavior stays intact.

See `docs/plans/2026-03-13-env-portability-and-secret-management-design.md` for the full portable env and key-sharing model.

## Files and storage

- `.hack/hack.env.json` (committed): declares env vars, required vs optional, per-service scope, and where values should come from.
- `.hack/.env` (local plaintext file): stores non-secret values (`source: "plain_env"`). Most repos should gitignore it, but Hack does not currently enforce that.
- `process.env` (ambient fallback): supplies `plain_env` values when `.hack/.env` is missing a key.
- Configured secret backend (`controlPlane.secrets.backend`): stores secret values for `source: "keychain"` contract vars.

## Contract format (`.hack/hack.env.json`)

```json
{
  "$schema": "https://schemas.hack/hack.env.schema.json",
  "version": 1,
  "vars": [
    {
      "key": "AWS_PROFILE",
      "required": true,
      "source": "plain_env",
      "services": ["api"],
      "description": "AWS profile used by the API service"
    },
    {
      "key": "DATABASE_URL",
      "required": true,
      "source": "keychain",
      "services": ["api", "worker"],
      "description": "Database connection string"
    }
  ]
}
```

Fields:

- `key`: uppercase snake-case env var name (e.g. `AWS_PROFILE`).
- `required`: if true, `hack up/run/restart` fails when missing (for targeted services).
- `source`:
  - `plain_env`: read from `.hack/.env`, then fall back to the current process env (`process.env`).
  - `keychain`: read from the OS keychain only.
- `services`: `null` (or omitted) means all services; otherwise a list of Compose service names.
- `description`: optional, for humans/UI.

## Portable managed artifact

Portable env management uses three layers:

- `.hack/hack.env.json`: committed declaration contract for keys, required flags, service scope, and descriptions
- `PortableProjectEnvArtifactV1`: canonical managed-value artifact for portability, import/export, and future remote publish/apply flows
- local compatibility storage: `.hack/.env` for plaintext values plus the configured secret backend for secret values

The managed artifact is intentionally separate from `.hack/hack.env.json`. The contract remains safe to commit. The managed artifact carries actual values plus intent metadata and should be encrypted as a whole when stored outside the local machine.

Suggested import/export filename:

- `.hack/hack.env.managed.json`
- schema URL: `https://schemas.hack/hack.env.managed.schema.json`

Artifact shape:

```json
{
  "$schema": "https://schemas.hack/hack.env.managed.schema.json",
  "version": 1,
  "environment": "default",
  "metadata": {
    "description": "Shared dev environment for Hack App",
    "updatedAt": "2026-03-13T18:00:00Z",
    "updatedBy": "cli",
    "source": "hack-cli"
  },
  "entries": [
    {
      "key": "AWS_REGION",
      "value": {
        "kind": "plaintext",
        "text": "us-east-1"
      },
      "required": true,
      "services": ["api"],
      "description": "AWS region used by the API"
    },
    {
      "key": "DATABASE_URL",
      "value": {
        "kind": "secret",
        "text": "postgres://..."
      },
      "required": true,
      "services": ["api", "worker"],
      "description": "Primary application database"
    }
  ]
}
```

Managed artifact rules:

- `entries[].value.kind` distinguishes logical plaintext from logical secrets
- `entries[].value.text` is the canonical string value before outer-envelope encryption
- duplicate keys and unsorted entry lists are parser and writer invariants; the JSON Schema documents the contract but cannot enforce those constraints on its own
- `services` belongs in the managed artifact because portability must preserve service intent outside the originating machine
- `metadata` captures human and CLI/Desktop provenance, not machine-local backend details
- the artifact must not store local absolute paths, keychain service names, backend provider configuration, or runtime resolution history such as `resolvedFrom`

Local compatibility rules:

- `.hack/.env` contains only plaintext values
- the configured secret backend contains only secret values keyed by env var name
- neither compatibility target stores descriptions, service scope, timestamps, or actor metadata
- compatibility targets are derived outputs and may be regenerated from the managed artifact at any time

Planned CLI behavior when a managed artifact is active:

1. Reads validate artifact keys against the normalized `.hack/hack.env.json` contract when present. Current contract parsing is looser than the published schema, so artifact-aware commands should surface drift instead of assuming strict schema parity.
2. Reads report artifact intent, local materialization state, and drift between them.
3. `hack env set` mutates the canonical artifact first, then materializes the entry to `.hack/.env` or the configured secret backend based on `value.kind`.
4. If an entry changes kind, Hack removes stale local state from the old compatibility target before writing the new one.

This behavior is design intent for the managed artifact workflow; it is not fully implemented by the current CLI yet.

See [docs/plans/2026-03-13-portable-project-env-artifact-schema-design.md](plans/2026-03-13-portable-project-env-artifact-schema-design.md) for the full design rationale and implementation boundary.

## CLI

- `hack env list [--json] [--show-secrets]`
  - shows contract + resolution state
  - includes a storage summary for the committed contract, local `.hack/.env`, ambient `process.env` fallback, configured secret backend mode, and current portable-state status
  - exits `1` if required vars are missing
- `hack env set KEY=VALUE`
  - writes to `.hack/.env`
- `hack env set --secret KEY=VALUE`
  - stores in the configured secret backend (`keychain` | `encrypted_file` | `cloud`)
- `hack env unset KEY`
  - removes from `.hack/.env` and deletes the secret backend entry (best-effort)
- `hack env backend status [--json]`
  - shows configured global backend strategy (`controlPlane.secrets`)
- `hack env backend use <keychain|encrypted_file|cloud> [--store-path <path>] [--provider <aws|gcp|azure|vault>] [--secret-project <id>] [--secret-prefix <prefix>]`
  - sets global backend strategy for multi-node/env secret storage

Notes:

- `hack env set` also supports interactive prompting when `KEY` or `VALUE` is omitted.
- Keychain mode uses service name `hack-<projectName>` (project name from `.hack/hack.config.json`).
- Encrypted-file mode uses `HACK_SECRETS_FILE_KEY` (if set) before keychain key lookup (`hack-secrets-backend/encrypted-file-key`).
- If you keep getting macOS keychain prompts in encrypted-file mode, set `HACK_SECRETS_FILE_KEY` in your shell/`.env.local` and restart `hackd`.
- `cloud` mode currently uses provider-scoped shim storage to validate adapter contracts before provider-native transports land.

## Backend Strategy Contract (`controlPlane.secrets`)

Global config supports backend selection for secret portability:

```json
{
  "controlPlane": {
    "secrets": {
      "backend": "keychain",
      "allowEnvAuthRefs": true,
      "encryptedFile": {
        "path": "~/.hack/secrets.enc.json"
      },
      "cloud": {
        "provider": "aws",
        "project": "dev-account",
        "secretPrefix": "hack"
      }
    }
  }
}
```

Fields:

- `backend`: `keychain` | `encrypted_file` | `cloud`.
- `allowEnvAuthRefs`: allow `env:VAR_NAME` auth/secret references for node/controller workflows.
- `encryptedFile.path`: target path for encrypted local store mode.
- `cloud.provider`: `aws` | `gcp` | `azure` | `vault`.
- `cloud.project`: account/project/workspace identifier.
- `cloud.secretPrefix`: namespacing prefix for secret keys.

## Runtime injection (compose)

When you run `hack up`, `hack restart`, or `hack run`, hack:

1. Resolves `.hack/hack.env.json` for the target services.
2. In interactive shells, offers to prompt for missing required vars (and writes to `.hack/.env` and/or configured secret backend).
3. Generates `.hack/.internal/compose.env.override.yml` that injects `${KEY}` placeholders into `services.<svc>.environment` based on the contract.
4. Invokes `docker compose` with an environment that includes resolved values (including secret backend values).

Security posture:

- Secret values are never written into `.hack/` YAML files.
- Plain env values typically live in `.hack/.env`, but Hack can also read them from the current process env for `plain_env` keys.
- `.hack/.env` should be gitignored by the repo, but Hack does not currently enforce that invariant during `hack init`.

Planned shared-admin direction:
- keep `hack env set` and `hack env unset` local by default
- require explicit broker-mediated flows for shared env grants, rotation, and encrypted value custody
- keep metadata sharing and value sharing as separate policy choices

## Remote node secret behavior

Current behavior (today):

- Node auth tokens and extension auth refs are stored through the configured secret backend.
- `env:VAR_NAME` auth refs are allowed only when `controlPlane.secrets.allowEnvAuthRefs=true`.
- Remote dispatch/workspace bootstrap does **not** automatically copy all host env values to remote nodes.

Recommended setup:

- Keep controller secrets in `keychain` or `encrypted_file` backend (not shell env).
- Configure each remote node to use the same secret backend strategy where possible.
- Use project env contract (`.hack/hack.env.json`) to make required keys explicit before runs.

Planned direction:

- Add an explicit host-to-node secret sync command with least-privilege scoping, encrypted payload delivery, and audit events per run.
- Keep the committed contract (`.hack/hack.env.json`) separate from the future portable managed-values artifact. See `docs/plans/2026-03-13-portable-project-env-artifact-schema-design.md`.

## Daemon/gateway API (UI integration)

`hackd` exposes env endpoints for UIs. When accessed through the gateway, all requests require an auth token:

- `Authorization: Bearer $HACK_GATEWAY_TOKEN`
- Non-GET requests additionally require `controlPlane.gateway.allowWrites = true` and a write-scoped token.

Endpoints:

- `GET /v1/env?project=<name>` (or `?project_id=<id>`)
- `POST /v1/env/set`
- `POST /v1/env/unset`

Example (read):

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  "http://127.0.0.1:7788/v1/env?project=my-project"
```

Example (set plain env):

```bash
curl -X POST -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:7788/v1/env/set \
  -d '{"project":"my-project","key":"AWS_PROFILE","value":"dev"}'
```

Example (set secret):

```bash
curl -X POST -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:7788/v1/env/set \
  -d '{"project":"my-project","key":"DATABASE_URL","value":"postgres://...","secret":true}'
```

Example (unset):

```bash
curl -X POST -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:7788/v1/env/unset \
  -d '{"project":"my-project","key":"AWS_PROFILE"}'
```
