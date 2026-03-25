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

## Auth-Broker Test Isolation

- Bun loads repo-root `.env` / `.env.local`, so auth-broker tests should clear broker-related env before asserting defaults or failure guidance.
- `services/auth-broker/tests/test-env.ts` provides `installAuthBrokerEnvIsolation()` for suites and `withIsolatedAuthBrokerEnv()` for per-test overrides.
- Those helpers set `HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK=true`, which disables `services/auth-broker/src/config.ts` fallback reads from repo-root `.env.local` and `.env` so config tests stay hermetic.

## Trusted-Origin Inventory

Use one explicit allowlist model for auth/session flows:
- local routed hosts: `https://hack-cli.hack`, `https://*.hack-cli.hack`, `https://hack-cli.hack.gy`, `https://*.hack-cli.hack.gy`
- local broker smoke URL only where direct HTTP validation is required: `http://127.0.0.1:8080`
- deploy-ready web origins from environment for Vercel preview/production (for example `https://<preview-domain>` and `https://<production-domain>`); do not hardcode a second deploy domain path outside env/config

Trusted-origin tests should exercise one allowed routed host, one allowed deploy-ready env-supplied origin, and one rejected untrusted origin.
