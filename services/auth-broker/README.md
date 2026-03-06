# @hack/auth-broker

Minimal Bun + Elysia auth broker for browser-based provider callbacks.

## Purpose

1. Start OAuth flows from local clients (CLI/macOS app).
2. Handle browser callback redirects.
3. Expose short-lived polling endpoints so local clients can claim tokens.
4. Host Better Auth endpoints (`/api/auth/*`) for first-party session/org/team auth.
5. Expose a minimal Hack auth shell (`/auth`, `/auth/account`) and a
   management-token bootstrap flow for non-browser clients.

This keeps provider auth UX one-click while storing long-term credentials on the
client host.

## Hack account vs provider integrations

The broker now has two distinct identity layers and the docs/UI need to keep
them separate.

### 1. Hack account auth

Hack account auth is first-party identity handled through Better Auth and the
broker auth shell:

- `GET /auth`
- `GET /auth/account`
- `GET /v1/auth/session/start`
- `GET /v1/auth/session/flows/:flowId`
- `GET /v1/auth/me`

CLI and macOS use this flow to claim and locally store a broker management
token for remote broker-owned features.

### 2. Provider integrations

Provider integrations are separate resources that sit under a Hack account.
Examples:

- GitHub provider OAuth/app installs
- Linear OAuth profiles, webhook deliveries, and autosync subscriptions

Signing into Hack with GitHub is not the same thing as connecting a GitHub
integration. The same separation applies to any future providers.

## Local vs remote boundary

Hack remains local-first.

### Local-only flows

These should continue to work without Hack sign-in:

- project/runtime orchestration
- local sessions
- local git-backed tickets
- local secret storage
- local provider tokens used purely on-device

### Remote/shared flows

These require Hack auth because they are broker-owned:

- broker-managed Linear connections
- broker-managed deliveries and autosync subscriptions
- future broker-managed GitHub account/org surfaces
- future remote encrypted project/env bundle portability

The product rule is:

- local-only = no Hack login required
- shared/remote = Hack login required

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
5. `src/modules/better-auth/shell-plugin.ts`
6. `src/modules/github-oauth/plugin.ts`
7. `src/modules/linear-agent/plugin.ts`

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
7. `GET /linear/callback`
8. `POST /linear/webhooks` (Linear agent + webhook ingest)
9. `POST /v1/integrations/linear/webhook` (legacy alias)
10. `GET /v1/auth/better-auth/status`
11. `GET /v1/auth/session/start`
12. `GET /v1/auth/session/flows/:flowId`
13. `GET /v1/auth/me`
14. `GET /auth`
15. `GET /auth/account`
16. `ALL /api/auth/*` (proxied to Better Auth handler)

When `requireInstallation=1` is used, flow polling can defer token claim until
an installation is visible for the flow, enabling one-pass authorize+install UX.

Callback success pages now include an `Open Hack app` deep link (`hack://...`)
so desktop users can return focus to the app immediately after browser auth.

## Hack auth session flow

The broker now exposes a lightweight Better Auth bootstrap flow that mirrors the
existing OAuth start/poll/claim pattern used by GitHub and Linear:

1. `GET /v1/auth/session/start`
2. Open the returned `authorizeUrl` in a browser
3. Browser completes Better Auth sign-in on `/auth` and `/auth/account`
4. Local client polls `GET /v1/auth/session/flows/:flowId`
5. Local client claims `managementToken` with `?claim=1`

The claimed token is a signed broker management token. It can be stored by the
CLI/macOS app and sent as `Authorization: Bearer <token>` to protected broker
routes when a browser cookie session is not present.

This token is:

- local client state
- scoped to Hack-account broker access
- separate from provider-specific access tokens

This token is not:

- a replacement for provider OAuth/app tokens
- a gateway or daemon transport bearer token
- a general-purpose local secret export mechanism

`GET /v1/auth/me` resolves either:

1. the current Better Auth browser session, or
2. a valid broker management token

The Better Auth shell surfaces provider-driven sign-in and account-link actions
from the providers configured in broker env. The runtime also enables strict
account-linking groundwork through Better Auth's own linking policy:

1. verified provider email required for implicit linking
2. different provider emails are not allowed by default
3. no trusted providers are pre-whitelisted

## Social provider configuration

The auth shell is provider-driven and env-driven.

### GitHub

`BETTER_AUTH_GITHUB_CLIENT_ID` and `BETTER_AUTH_GITHUB_CLIENT_SECRET` are the
preferred creds for Hack sign-in with GitHub.

If those are not set, the broker falls back to `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`.

Product surfaces must still distinguish:

- `Sign in to Hack with GitHub`
- `Connect GitHub integration`

### Google

`BETTER_AUTH_GOOGLE_CLIENT_ID` and `BETTER_AUTH_GOOGLE_CLIENT_SECRET` are the
preferred creds for Google sign-in in the Better Auth shell.

If those are not set, the broker falls back to `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`.

Google is currently:

- a Hack sign-in method
- rendered only when both env vars are configured
- not a separate provider-integration surface in this broker

### Rendering rule

The auth shell should render only the configured social providers at runtime.
Do not hardcode provider promises in desktop or CLI copy that the broker is not
currently configured to serve.

## Verified-email account linking

Hack account linking is intentionally strict.

Automatic linking is allowed only when:

- the provider returns an email
- that email is verified
- the normalized email matches an existing Hack user

Automatic linking is refused when:

- email is missing
- email is unverified
- emails do not match

Trusted-provider bypasses are empty by default. This is an auth boundary, not a
convenience feature.

## Remote env portability boundary

Remote encrypted project/env portability is follow-on work and should build on
Hack account ownership, not on provider identity.

- ownership is Hack user/org/team scoped
- broker stores ciphertext plus metadata, not general plaintext env state
- provider-token portability is out of scope
- local decrypt/apply remains the first implementation boundary

## Environment

1. `GITHUB_CLIENT_ID` (required for GitHub provider OAuth routes)
2. `GITHUB_CLIENT_SECRET` (required for GitHub provider OAuth routes)
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
18. `BETTER_AUTH_GITHUB_CLIENT_ID` (optional; preferred GitHub social login client id for `/auth`)
19. `BETTER_AUTH_GITHUB_CLIENT_SECRET` (optional; preferred GitHub social login client secret for `/auth`)
20. `BETTER_AUTH_GOOGLE_CLIENT_ID` (optional; preferred Google social login client id for `/auth`)
21. `BETTER_AUTH_GOOGLE_CLIENT_SECRET` (optional; preferred Google social login client secret for `/auth`)
22. `GOOGLE_CLIENT_ID` (optional fallback; enables Google social sign-in in `/auth` when dedicated Better Auth creds are not set)
23. `GOOGLE_CLIENT_SECRET` (optional fallback; enables Google social sign-in in `/auth` when dedicated Better Auth creds are not set)
24. `BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS` (optional boolean; when true, callback can create a Better Auth user from GitHub email if no match exists)
25. `BETTER_AUTH_LINEAR_AUTO_PROVISION_USERS` (optional boolean; when true, callback can create a Better Auth user from Linear email if no match exists)
26. `HACK_LINEAR_CLIENT_ID` (recommended Linear OAuth client id)
27. `HACK_LINEAR_SECRET` (optional Linear OAuth client secret; PKCE can run without it)
28. `HACK_LINEAR_DEVELOPER_APP_TOKEN` (optional app token for agent/system automations)
29. `HACK_LINEAR_WEBHOOK_SECRET` (recommended Linear webhook signing secret)
30. `HACK_LINEAR_SCOPES` (optional; default: `read,write,app:mentionable,app:assignable`)
31. `HACK_LINEAR_OAUTH_ACTOR` (optional; default: `app` for Linear agent/app installs)
32. `HACK_LINEAR_REDIRECT_URI` (default: `${AUTH_BROKER_PUBLIC_BASE_URL}/linear/callback`)
33. `HACK_LINEAR_WEBHOOK_PATH` (default: `/linear/webhooks`)
34. `HACK_LINEAR_AUTHORIZE_URL` (optional; default: `https://linear.app/oauth/authorize`)
35. `HACK_LINEAR_TOKEN_URL` (optional; default: `https://api.linear.app/oauth/token`)
32. `HACK_LINEAR_API_BASE_URL` (optional; default: `https://api.linear.app`)
33. `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` / `LINEAR_WEBHOOK_SIGNING_SECRET` / `LINEAR_OAUTH_ACTOR` (optional compatibility aliases)

`services/auth-broker/.env.example` reflects the recommended grouping:

- GitHub env powers both provider OAuth and GitHub sign-in
- Google env powers Google sign-in only
- Better Auth env powers Hack account/session ownership
- Linear env powers provider integration flows and agent webhooks

When running broker from repo root (`bun run auth:dev`), Linear env aliases also
fallback to root `.env.local` / `.env` if process env values are unset.

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
