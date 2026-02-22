# Auth Broker Neon Bootstrap

Use this guide to do a one-time setup for the `auth-broker` service with Neon
credentials and optional Railway variable provisioning.

## Quick Start

```bash
bun run auth:bootstrap:neon \
  --neon-project "<id-or-name>" \
  --railway-project "hack" \
  --railway-service "auth-broker" \
  --create-railway-service
```

This command:

1. Resolves the Neon project (`id` or exact name).
2. Fetches an extended connection string via `neonctl connection-string`.
3. Writes `DATABASE_URL`, `NEON_PROJECT_ID`, and `BETTER_AUTH_SECRET` to:
   - `services/auth-broker/.env.local`
4. Pushes the same keys into Railway service variables.
5. Triggers one Railway service redeploy.

Secrets are not printed to stdout.

## Safe Preview

```bash
bun run auth:bootstrap:neon \
  --neon-project "<id-or-name>" \
  --railway-project "hack" \
  --railway-service "auth-broker" \
  --dry-run \
  --json
```

## Common Flags

1. `--skip-railway`: local env only.
2. `--skip-local`: Railway variables only.
3. `--local-env-file=<path>`: override env file path.
4. `--railway-environment=<name>`: defaults to `production`.
5. `--railway-workspace=<id|name>`: optional workspace selector.
6. `--neon-branch=<branch>`: use non-default branch connection string.
7. `--neon-role=<role>`: request role-specific connection string.
8. `--neon-database=<db>`: request database-specific connection string.
9. `--neon-pooled`: request pooled Neon connection.
10. `--better-auth-secret=<value>`: explicitly provide secret instead of auto-generated.

## Prerequisites

1. `bunx neonctl me` succeeds.
2. `railway whoami` succeeds (unless using `--skip-railway`).

## Troubleshooting

1. `Neon project "... not found"`:
   - run `bun run neon:projects` and pick exact id.
2. Railway link failure:
   - verify project/environment names in `railway project list --json`.
3. Railway variable set failure due missing service:
   - pass `--create-railway-service` or set `--railway-service` to an existing service.
