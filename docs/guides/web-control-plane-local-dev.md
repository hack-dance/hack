# Run the Optional Web Control Plane Locally

This guide covers the local development paths for `apps/web`, the optional Hack
web control plane.

Start in [Core docs](../core.md) first if you are new to `hack`. This guide is
for the browser control-plane surface, not the default local CLI workflow.

## What this guide covers

There are two useful local modes:

1. Standalone web shell via `bun run --cwd apps/web dev`
2. Routed, broker-backed stack via `hack up --detach`

Use standalone mode when you only need to verify rendering, route wiring, or
fail-closed auth behavior. Use the `hack`-managed stack when you want the real
local hostnames, auth-broker integration, and browser spot checks that match the
intended product path.

## Mode 1: standalone app shell

Run:

```bash
bun run --cwd apps/web dev
```

Default local endpoints:

- app: `http://127.0.0.1:3000`
- auth broker fallback: `http://127.0.0.1:8080`

What to expect:

- `/`, `/auth`, and `/account` should render
- auth will fail closed when broker metadata is unavailable
- the sign-in page may show `Sign-in is unavailable` and `No shared social providers are configured for this environment yet`

This mode is still useful because it proves the web shell loads without a live
broker session.

## Mode 2: routed local stack with `hack`

Prefer this mode for real UI spot checks.

Run:

```bash
hack doctor
hack up --detach
hack ps
hack open --json
```

The project compose file exposes:

- web app at `https://hack-cli.hack`
- auth broker at `https://auth.hack-cli.hack`
- OAuth-safe alias hosts at `https://hack-cli.hack.gy` and `https://auth.hack-cli.hack.gy`

The current local stack wires these env values through `.hack/docker-compose.yml`:

- `HACK_WEB_APP_BASE_URL`
- `NEXT_PUBLIC_HACK_WEB_APP_BASE_URL`
- `HACK_AUTH_BROKER_URL`
- `HACK_AUTH_BROKER_INTERNAL_URL`
- `NEXT_PUBLIC_HACK_AUTH_BROKER_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`

If `hack doctor` warns about missing env mode files, that is a project config
gap, not necessarily a web-app failure. The routed stack can still come up if
the compose env is otherwise complete.

## Verification checklist

Use the strongest loop that matches what you are changing.

Code and test loops:

- `bun run --cwd apps/web typecheck`
- `bun run --cwd apps/web test`
- `bun run --cwd apps/web build`

Routed browser loop:

- `hack up --detach`
- `hack ps`
- open `https://hack-cli.hack`
- open `https://hack-cli.hack/auth?redirect=%2F`
- open `https://hack-cli.hack/auth/account?redirect=https%3A%2F%2Fhack-cli.hack%2F`

Fast HTTP checks:

```bash
curl -k -I https://hack-cli.hack
curl -k -I https://auth.hack-cli.hack
hack logs web --no-follow --tail 80
hack logs auth-broker --no-follow --tail 80
```

## Common failure modes

### `Sign-in is unavailable`

The web app loaded, but the broker metadata endpoint reported no enabled shared
providers or could not be reached. Verify broker env and provider configuration
before treating this as a rendering bug.

### Next.js blocks dev assets for `hack-cli.hack`

When the dev server is reached through the routed `.hack` hostname instead of
`localhost`, Next.js requires `allowedDevOrigins` to include that hostname. The
repo should derive this from the same app-base-url and trusted-origin env
contract used by the auth handoff.

### `next-env.d.ts` or `tsconfig.json` becomes dirty after a dev run

Next.js may rewrite these files during local development. Keep the tracked files
clean before committing.

## Shut down

```bash
hack down
```
