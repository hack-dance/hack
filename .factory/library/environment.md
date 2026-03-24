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

## Tooling Notes

- Bun is the canonical runtime and validator path for this repo.
- The local machine currently has Bun available, but the installed version may lag the version declared in `package.json`; prefer repo commands and keep validation evidence concrete.
- Use `./dist/hack` for repo-bound CLI behavior after build; use global `hack` only for runtime orchestration.

## Trusted-Origin Inventory

Use one explicit allowlist model for auth/session flows:
- local routed hosts: `https://hack-cli.hack`, `https://*.hack-cli.hack`, `https://hack-cli.hack.gy`, `https://*.hack-cli.hack.gy`
- local broker smoke URL only where direct HTTP validation is required: `http://127.0.0.1:8080`
- deploy-ready web origins from environment for Vercel preview/production (for example `https://<preview-domain>` and `https://<production-domain>`); do not hardcode a second deploy domain path outside env/config

Trusted-origin tests should exercise one allowed routed host, one allowed deploy-ready env-supplied origin, and one rejected untrusted origin.
