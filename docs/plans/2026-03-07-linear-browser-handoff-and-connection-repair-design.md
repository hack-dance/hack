# Linear Browser Handoff And Connection Repair Design

## Context

Hack account login now uses a broker-backed browser handoff flow with a dedicated auth shell, Better Auth session ownership, and desktop deep-link return. GitHub OAuth uses the same model for provider connection, but Linear still uses an older callback path at `/linear/callback` with a bespoke completion page and weaker error handling.

That mismatch is now causing two concrete failures:

1. Production Linear reconnects can fail with a host-level `502` instead of a Hack-branded error page.
2. Desktop Linear settings can get stuck in `Waiting for browser auth` because the browser callback contract is weaker than the GitHub path.

A second constraint is now explicit from product UX work: the app should not force users to reason about `remote connection` versus `local token/profile` unless they are using detailed diagnostics. Default UI should collapse to `connected` or `not connected` and recover smoothly when a repair is needed.

## Goals

- Unify Linear browser callback behavior with the GitHub OAuth contract.
- Ensure Linear callback failures always render a Hack page instead of leaking raw infrastructure errors.
- Persist Hack-account-owned Linear connection state reliably in the broker.
- Keep local token/profile claim behavior for the current sync engine, but hide that implementation detail from normal UI.
- Make desktop and CLI stop hanging on browser flows that have already failed or gone stale.

## Non-Goals

- Replacing the current local Linear token envelope with broker-primary token execution.
- Solving full cross-device provider-token portability in this pass.
- Reworking Linear’s upstream authorization/install UX.

## Approaches Considered

### 1. Full callback unification with GitHub pattern (recommended)

Linear start flow stores the same desktop redirect context as GitHub. The callback exchanges the token, persists broker-owned connection state, marks the flow complete, and renders a Hack completion/error page with an `Open Hack` action. Desktop and CLI still claim local token state from the flow, but the browser contract becomes authoritative for success and failure.

Pros:
- Fixes the live `502` problem at the root.
- Makes GitHub and Linear auth behavior consistent.
- Preserves current sync-engine assumptions.
- Gives a clean base for later token portability work.

Cons:
- Requires touching broker, CLI, and macOS flow handling in one pass.

### 2. Patch the existing Linear callback only

Keep Linear on its older contract, add top-level exception handling, and restyle the page to match the newer auth shell.

Pros:
- Smaller code change.

Cons:
- Preserves two OAuth callback models.
- Leaves desktop/browser state transitions more fragile.
- Does not simplify future maintenance.

### 3. Make browser callback remote-only and defer local access to later repair

Treat browser callback as remote connection creation only. Desktop later seeds local token state from the broker.

Pros:
- Architecturally cleaner long term.

Cons:
- Too much scope for the current fix.
- Pulls provider-token portability into an already-broken live path.

## Recommended Design

Adopt approach 1: Linear should follow the same browser handoff model as GitHub, with remote connection persistence in the broker and local token claim still supported for this Mac.

## Architecture

### Broker Flow Lifecycle

#### Start

`/v1/auth/linear/start` should continue returning:
- `authorizeUrl`
- `pollUrl`
- `deviceCode`
- `flowId`
- `expiresAt`

It should additionally persist the same desktop redirect context pattern used by GitHub so the callback page can reliably return focus to Hack.

#### Callback

`/linear/callback` becomes a strict browser-completion route:
- validate flow state
- exchange authorization code for token
- fetch Linear identity
- resolve Better Auth linkage
- persist/update `linear_connections`
- mark flow complete with claimable local token data
- render Hack-branded completion page with `Open Hack`

The route must never surface an uncaught exception to Cloudflare.

#### Claim

Desktop and CLI continue using the existing poll-and-claim behavior so the current local sync engine keeps working. This preserves compatibility while letting the browser flow become more reliable.

### State Model

Internally, Linear connection state remains split into:
- broker-owned Hack-account connection state
- local claimed token/profile state for the current Mac

Externally, normal UI should flatten this into a simple connection story:
- `Connected`
- `Connecting`
- `Needs attention`
- `Not connected`

Remote/local detail should only appear in diagnostics, CLI JSON, or explicit recovery messaging.

## UX Rules

### Browser Pages

Linear callback pages should use the same design system as GitHub auth pages:
- dark, flat full-page shell
- centered `HACK`
- minimal copy
- outline actions only
- no bubbly cards or heavy explanatory blocks

There are two page classes:
- handoff pages: one primary action (`Continue with Linear` or `Open Hack`)
- recovery pages: one short status line plus `Try again` or `Open Hack`

### Desktop

Desktop should stop presenting the browser flow as indefinitely pending.

If broker flow state becomes:
- `complete` or `claimed`: show connected state
- `error`: show compact repair state
- `expired`: show reconnect state

Default desktop copy should avoid exposing remote/local implementation detail unless recovery is needed. Example:
- normal: `Connected`
- repair: `Connected on Hack, local access needs repair`

### CLI

Human-facing CLI output should also stay simple by default, while `--json` continues to expose remote/local specifics for debugging and automation.

## Failure Handling

The Linear callback handler needs a top-level failure boundary.

Any unexpected exception should:
- mark the flow errored when possible
- return a Hack-branded `Connection failed` page
- avoid raw `502` host errors

Expected failures should become explicit Hack pages:
- missing state
- expired session
- provider denied access
- token exchange failed
- identity lookup failed
- connection persistence/claim prep failed

## Testing

### Broker

Add coverage for:
- successful Linear callback completion
- token exchange failure renders Hack error page
- unexpected callback exception renders Hack error page instead of surfacing host failure
- callback page includes `Open Hack` when desktop redirect is present
- persisted connection row is written before flow completion is reported

### CLI/Desktop

Add coverage for:
- Linear start flow carrying desktop redirect context
- poll loop stopping cleanly on `error` and `expired`
- UI state mapping from broker flow status to compact connected/repair states

### Live Verification

After deploy:
- sign in to Hack
- revoke existing Linear install
- reconnect Linear
- confirm browser callback lands on Hack-branded completion page
- confirm app returns from browser and shows connected state
- confirm `hack x linear connections --json` shows persisted remote connection

## Rollout

1. Unify broker Linear callback contract and error handling.
2. Update desktop/CLI to use the same callback semantics as GitHub.
3. Simplify Linear settings state model to binary default UX with repair-only detail.
4. Deploy and re-run live reconnect flow.
5. Revisit full provider-token portability after the callback contract is stable.
