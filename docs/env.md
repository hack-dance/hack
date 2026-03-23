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

## Files and storage

- `.hack/hack.env.json` (committed): declares env vars, required vs optional, per-service scope, and where values should come from.
- `.hack/.env` (gitignored): stores non-secret values (`source: "plain_env"`).
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

## CLI

- `hack env list [--json] [--show-secrets]`
  - shows contract + resolution state
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
- Plain env values live in `.hack/.env` (expected to be gitignored in most repos).

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
