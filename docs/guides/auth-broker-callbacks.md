# Auth Broker Callback Contracts

Hack keeps browser auth UI in `apps/web`, but callback ownership stays on
`services/auth-broker`.

## GitHub Callback Layers

- Broker custom GitHub OAuth callback:
  - `GITHUB_REDIRECT_URI`
  - defaults to `${AUTH_BROKER_PUBLIC_BASE_URL}/gh/callback`
  - used by Hack-owned GitHub/browser/CLI orchestration flows
- Better Auth browser session callback:
  - derived from `BETTER_AUTH_URL`
  - resolves to `${BETTER_AUTH_URL}/api/auth/callback/github`
  - used by Better Auth social sign-in on the broker

## Browser Handoff Layers

- Next-owned sign-in and account UI:
  - `${HACK_WEB_APP_BASE_URL}/auth`
  - `${HACK_WEB_APP_BASE_URL}/auth/account`
- Broker browser-start redirect:
  - `${AUTH_BROKER_PUBLIC_BASE_URL}/v1/auth/session/browser/start?provider=...&redirect=...`
  - starts Better Auth social sign-in without rendering broker UI
- Broker browser-complete redirect:
  - `${AUTH_BROKER_PUBLIC_BASE_URL}/v1/auth/session/browser/complete?redirect=...`
  - runs after the Better Auth callback, sets the shared browser-session cookie,
    completes any linked device flow, and redirects back to the Next app

The browser signs in through the broker, but the user only sees Next-owned auth
pages. The broker now participates through redirect/API endpoints, not
broker-hosted handoff UI.

## Rule Of Thumb

- If you are changing Hack-owned GitHub OAuth flow config, check `/gh/callback`.
- If you are changing Better Auth browser social login, check
  `/api/auth/callback/github`.
- If you are changing browser handoff UX, update the Next auth pages first and
  then verify the broker `browser/start` and `browser/complete` redirect
  contract still returns to the Next app correctly.
- Do not treat the Next app as the provider callback owner unless the auth stack
  is explicitly migrated there.
