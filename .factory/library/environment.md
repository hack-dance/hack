# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required env vars, external services, credential assumptions, platform/runtime quirks.
**What does NOT belong here:** service ports or lifecycle commands (use `.factory/services.yaml`).

---

## Credential Assumptions

- Existing local/remote credentials for Hack, GitHub, Linear, Railway, and Neon are assumed to be the source of truth for this mission.
- New env wiring may be added for `apps/web`, but live Vercel deployment is out of scope; the app only needs to be local + deploy-ready.
- Gateway writes are disabled by default and may be temporarily enabled only for explicit validation steps that require them.

## Auth-Broker Runtime Inputs

The broker already depends on environment such as:
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `HACK_PROVIDER_TOKEN_ENCRYPTION_KEY`
- any trusted-origin configuration needed for local Hack hosts and deploy-ready web origins

Workers should extend existing env handling rather than introducing parallel secret/config channels.

Repo-bound broker-auth verification can also use:
- `HACK_AUTH_SESSION_TOKEN`
- `HACK_AUTH_SESSION_EXPIRES_AT`

These let repo-bound CLI flows prove an authenticated broker session without reading stored local secret or keychain-backed auth state first. Use them when validating keychainless broker-seeded Linear flows.

## Web Auth Runtime Inputs

`apps/web/src/lib/auth-config.ts` currently derives the browser auth contract from:
- app base URL: `NEXT_PUBLIC_HACK_WEB_APP_BASE_URL`, `HACK_WEB_APP_BASE_URL`, `NEXT_PUBLIC_APP_BASE_URL`, `APP_BASE_URL`
- broker public base URL: `NEXT_PUBLIC_HACK_AUTH_BROKER_URL`, `HACK_AUTH_BROKER_URL`, `AUTH_BROKER_PUBLIC_BASE_URL`
- broker internal/proxy base URL: `HACK_AUTH_BROKER_INTERNAL_URL`, `AUTH_BROKER_INTERNAL_URL`
- trusted origins: `BETTER_AUTH_TRUSTED_ORIGINS`
- local routed-host inference override: `HACK_LOCAL_DEV_HOST`, `NEXT_PUBLIC_HACK_LOCAL_DEV_HOST`

When verifying provider parity or browser handoff behavior, prefer these variables over introducing app-specific aliases outside the shared auth-config path.

## Tooling Notes

- Bun is the canonical runtime and validator path for this repo.
- The local machine currently has Bun available, but the installed version may lag the version declared in `package.json`; prefer repo commands and keep validation evidence concrete.
- Use `./dist/hack` for repo-bound CLI behavior after build; use global `hack` only for runtime orchestration.
- Repo-external Bun smoke scripts are a poor fit for monorepo validation here: if a smoke needs workspace imports such as `@hack/auth-contract`, keep the script under the repo root or use an existing repo-resident entrypoint instead of generating it under `/tmp`.
- Bun/WHATWG URL parsing normalizes dot segments before most handlers inspect `req.url` or `URL.pathname`; security-sensitive route validation that needs to reject raw traversal attempts cannot rely on normalized pathname checks alone.

For outage-mode proofs of repo-local CLI fallback behavior, point broker traffic at a dead local address with `HACK_AUTH_BROKER_URL=http://127.0.0.1:9` and set `HACK_SETUP_SYNC_MODE=off` so setup-sync noise does not mask the intended offline signal.

## Auth-Broker Test Isolation

- Bun loads repo-root `.env` / `.env.local`, so auth-broker tests should clear broker-related env before asserting defaults or failure guidance.
- `services/auth-broker/tests/test-env.ts` provides `installAuthBrokerEnvIsolation()` for suites and `withIsolatedAuthBrokerEnv()` for per-test overrides.
- Those helpers set `HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK=true`, which disables `services/auth-broker/src/config.ts` fallback reads from repo-root `.env.local` and `.env` so config tests stay hermetic.
- Use `withAuthBrokerRootEnvFallback()` plus `configureRootEnvFallbackForTests()` when a regression needs deterministic fake repo-root dotenv contents without depending on ambient checkout state.

## Env Status Taxonomy

- `trust_model` answers whether env state is local-only, plaintext-compatible, or broker/shared.
- `custody` answers who currently holds the sensitive material (for example local secret backend vs broker-managed).
- `portability` answers whether the current representation can move safely across machines.
- `shared_state` is the cross-surface summary used by CLI/API/web status views; treat unknown or command-error states explicitly instead of relabeling them as local-only.

## Secret Storage Notes

- `HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK=true` disables encrypted-file fallback to keychain-backed material; use it when recovery tests must prove there is no silent downgrade to local keychain access.

## Trusted-Origin Inventory

Use one explicit allowlist model for auth/session flows:
- local routed hosts: `https://hack-cli.hack`, `https://*.hack-cli.hack`, `https://hack-cli.hack.gy`, `https://*.hack-cli.hack.gy`
- local broker smoke URL only where direct HTTP validation is required: `http://127.0.0.1:8080`
- deploy-ready web origins from environment for Vercel preview/production (for example `https://<preview-domain>` and `https://<production-domain>`); do not hardcode a second deploy domain path outside env/config

Trusted-origin tests should exercise one allowed routed host, one allowed deploy-ready env-supplied origin, and one rejected untrusted origin.
