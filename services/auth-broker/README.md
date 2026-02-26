# @hack/auth-broker

Minimal Bun + Elysia auth broker for browser-based provider callbacks.

## Purpose

1. Start OAuth flows from local clients (CLI/macOS app).
2. Handle browser callback redirects.
3. Expose short-lived polling endpoints so local clients can claim tokens.
4. Host Better Auth endpoints (`/api/auth/*`) for first-party session/org/team auth.

This keeps provider auth UX one-click while storing long-term credentials on the
client host.

## Security boundary

`auth-broker` handles cloud identity/provider OAuth only.

1. It does **not** issue or validate gateway/daemon transport bearer tokens.
2. Gateway auth remains local-node transport auth and is intentionally isolated.
3. Token import into hack profiles happens on the client side after OAuth claim.

## Architecture (Elysia plugin-first)

The broker uses feature-scoped Elysia plugins so middleware and auth providers
stay decoupled:

1. `src/plugins/shared-middleware.ts`
2. `src/modules/core/plugin.ts`
3. `src/modules/providers/plugin.ts`
4. `src/modules/better-auth/plugin.ts`
5. `src/modules/github-oauth/plugin.ts`

GitHub OAuth routes are internally composed from focused plugins so callback,
provider, and polling route plumbing can evolve independently:

1. `src/modules/github-oauth/start-routes-plugin.ts`
2. `src/modules/github-oauth/callback-routes-plugin.ts`
3. `src/modules/github-oauth/flow-status-routes-plugin.ts`

App composition is centralized in `src/app.ts` and `src/index.ts` only handles
runtime startup.

### Adding shared middleware

Add cross-cutting middleware in `src/plugins/shared-middleware.ts` (for example
request-id handling, security headers, tracing, rate-limit decorators), then
compose once in `createAuthBrokerApp`. Read-only routes (`/health`, provider
catalog, and GitHub OAuth route surface) are guarded here and consistently
return `405` for non-`GET` requests.

### Adding a new auth provider

1. Create `src/modules/<provider>/model.ts` and `plugin.ts`.
2. Keep controller logic route-only (validation + HTTP adaptation).
3. Move business logic into service helpers to keep type integrity.
4. Register plugin in `src/app.ts`.

## Routes

1. `GET /health`
2. `GET /v1/auth/providers`
3. `GET /v1/auth/github/start` (`requireInstallation=1` supported)
4. `GET /gh/start`
5. `GET /gh/callback`
6. `GET /v1/auth/github/flows/:flowId`
7. `GET /v1/auth/better-auth/status`
8. `ALL /api/auth/*` (proxied to Better Auth handler)

When `requireInstallation=1` is used, flow polling can defer token claim until
an installation is visible for the flow, enabling one-pass authorize+install UX.

Callback success pages now include an `Open Hack app` deep link (`hack://...`)
so desktop users can return focus to the app immediately after browser auth.

## Environment

1. `GITHUB_CLIENT_ID` (required)
2. `GITHUB_CLIENT_SECRET` (required)
3. `GITHUB_SCOPES` (optional; default: `read:user,user:email,read:org`)
4. `GITHUB_APP_ID` (optional; returned in flow metadata for app-mode binding)
5. `GITHUB_APP_SLUG` (optional; used to build install URL)
6. `GITHUB_APP_INSTALL_URL` (optional; overrides default install URL)
7. `AUTH_BROKER_PUBLIC_BASE_URL` (default: `http://127.0.0.1:8080`)
8. `GITHUB_REDIRECT_URI` (default: `${AUTH_BROKER_PUBLIC_BASE_URL}/gh/callback`)
9. `PORT` (default: `8080`)
10. `HOST` (default: `0.0.0.0`)
11. `FLOW_TTL_MS` (default: `600000`)
12. `FLOW_SWEEP_INTERVAL_MS` (default: `30000`)
13. `FLOW_STORE_PATH` (default: `.data/oauth-flows.json`)
14. `DATABASE_URL` (required to enable Better Auth runtime)
15. `BETTER_AUTH_SECRET` (required to enable Better Auth runtime)
16. `BETTER_AUTH_URL` (optional base URL override)
17. `BETTER_AUTH_TRUSTED_ORIGINS` (optional comma-separated origins)
18. `BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS` (optional boolean; when true, callback can create a Better Auth user from GitHub email if no match exists)

## GitHub App setup (permissions + private key)

For GitHub App auth, GitHub enforces the app's configured permissions. OAuth
`scope` is not the primary permission model for GitHub Apps, and GitHub can
return an empty scope for App user tokens.

Broker defaults request `read:user,user:email,read:org` so callback can resolve
identity metadata (including email) for local account mapping.

Recommended app permissions for current Hack PR automation surface:

1. Repository `Contents`: **Read and write** (branch push/update workflows).
2. Repository `Pull requests`: **Read and write** (find/create/update PR).
3. Repository `Issues`: **Read and write** (post PR comments via issues API).
4. Repository `Metadata`: **Read-only** (required baseline).

Recommended app settings:

1. Callback URL: `https://auth.hack.broker/gh/callback` (must match exactly).
2. Enable "Request user authorization (OAuth) during installation".
3. Webhook can stay disabled for now unless you need inbound events.

Private key handling:

1. Do not commit `.pem` files to this repo.
2. Keep PEM in local secure storage temporarily, then import via stdin.
3. Let Hack store key material in local keychain (service: `hack-github-auth`).

Example one-time profile bootstrap (App mode):

```bash
cat /absolute/path/to/github-app.private-key.pem | hack x github connect \
  --profile default \
  --app-id "<github-app-id>" \
  --installation-id "<installation-id>" \
  --private-key-stdin \
  --set-default
```

If you need to discover installation id first:

```bash
hack x github oauth-connect --profile default --set-default
hack x github status --profile default --json
```

## One-Time Neon Bootstrap

Use the root helper to pull Neon DB credentials and seed local + Railway env:

```bash
bun run auth:bootstrap:neon \
  --neon-project "<id-or-name>" \
  --railway-project "hack" \
  --railway-service "auth-broker" \
  --create-railway-service
```

Notes:

1. Writes/updates `services/auth-broker/.env.local` with `DATABASE_URL`, `NEON_PROJECT_ID`, and `BETTER_AUTH_SECRET`.
2. Pushes the same keys to Railway service variables (unless `--skip-railway`).
3. Use `--dry-run --json` first to verify without writing secrets.
4. Copy `services/auth-broker/.env.example` if you want a manual template first.

## Commands

```bash
bun run --cwd services/auth-broker dev
bun run --cwd services/auth-broker typecheck
bun run --cwd services/auth-broker test
bun run --cwd services/auth-broker auth:generate
bun run --cwd services/auth-broker auth:migrate
bun run auth:bootstrap:neon --neon-project "<id-or-name>" --dry-run --json
```

## Railway Deploy (Dockerfile)

`services/auth-broker/railway.json` is configured for Dockerfile deploys.

When Railway config-as-code is set to `services/auth-broker/railway.json`,
deploy from repository root so Railway can resolve that path:

```bash
cd /path/to/repo-root
railway up \
  --service auth-broker \
  --environment production \
  --detach
```

If you deploy from `services/auth-broker`, Railway uploads only that directory
and cannot resolve `services/auth-broker/railway.json`.
