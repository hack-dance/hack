# @hack/auth-broker

Minimal Bun + Elysia auth broker for browser-based provider callbacks.

## Purpose

1. Start OAuth flows from local clients (CLI/macOS app).
2. Handle browser callback redirects.
3. Expose short-lived polling endpoints so local clients can claim tokens.
4. Host Better Auth endpoints (`/api/auth/*`) for first-party session/org/team auth.

This keeps provider auth UX one-click while storing long-term credentials on the
client host.

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
3. `GET /v1/auth/github/start`
4. `GET /gh/start`
5. `GET /gh/callback`
6. `GET /v1/auth/github/flows/:flowId`
7. `GET /v1/auth/better-auth/status`
8. `ALL /api/auth/*` (proxied to Better Auth handler)

## Environment

1. `GITHUB_CLIENT_ID` (required)
2. `GITHUB_CLIENT_SECRET` (required)
3. `AUTH_BROKER_PUBLIC_BASE_URL` (default: `http://127.0.0.1:8080`)
4. `GITHUB_REDIRECT_URI` (default: `${AUTH_BROKER_PUBLIC_BASE_URL}/gh/callback`)
5. `PORT` (default: `8080`)
6. `HOST` (default: `0.0.0.0`)
7. `FLOW_TTL_MS` (default: `600000`)
8. `FLOW_SWEEP_INTERVAL_MS` (default: `30000`)
9. `DATABASE_URL` (required to enable Better Auth runtime)
10. `BETTER_AUTH_SECRET` (required to enable Better Auth runtime)
11. `BETTER_AUTH_URL` (optional base URL override)
12. `BETTER_AUTH_TRUSTED_ORIGINS` (optional comma-separated origins)

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
