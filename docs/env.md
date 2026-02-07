# Env & secrets

hack supports a project-scoped env contract (shareable, no values) plus safe secret storage for local development.

## Files and storage

- `.hack/hack.env.json` (committed): declares env vars, required vs optional, per-service scope, and where values should come from.
- `.hack/.env` (gitignored): stores non-secret values (`source: "plain_env"`).
- OS keychain (via `Bun.secrets`): stores secret values (`source: "keychain"`), namespaced as `hack-<projectName>`.

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
  - stores in OS keychain (`Bun.secrets`)
- `hack env unset KEY`
  - removes from `.hack/.env` and deletes the keychain entry (best-effort)

Notes:
- `hack env set` also supports interactive prompting when `KEY` or `VALUE` is omitted.
- Keychain service name is `hack-<projectName>` (project name from `.hack/hack.config.json`).

## Runtime injection (compose)

When you run `hack up`, `hack restart`, or `hack run`, hack:

1. Resolves `.hack/hack.env.json` for the target services.
2. In interactive shells, offers to prompt for missing required vars (and writes to `.hack/.env` and/or keychain).
3. Generates `.hack/.internal/compose.env.override.yml` that injects `${KEY}` placeholders into `services.<svc>.environment` based on the contract.
4. Invokes `docker compose` with an environment that includes resolved values (including keychain secrets).

Security posture:
- Secret values are never written into `.hack/` YAML files.
- Plain env values live in `.hack/.env` (expected to be gitignored in most repos).

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

