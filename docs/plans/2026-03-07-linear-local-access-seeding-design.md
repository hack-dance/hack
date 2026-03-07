# Linear Local Access Seeding Design

## Context

Hack now owns Linear connection state remotely in the auth broker, but the current sync engine still requires a locally stored Linear token envelope on each Mac. After the browser callback flow completes once, the provider token is only available through the short-lived OAuth flow claim. If a second Mac signs in later, or if the original Mac loses keychain state, Hack can see the remote Linear connection but cannot reseed local access without sending the user back through Linear OAuth again.

That creates a broken product boundary:
- Hack account state says the Linear account exists.
- The app and CLI still fail local sync work because local access is missing.
- The default UX collapses into confusing states such as `0 provider accounts`, `Waiting for browser auth`, or generic reconnect instructions.

## Goals

- Let a signed-in Hack client reseed local Linear access from an existing Hack-owned remote connection.
- Keep the default UX flattened to `Connected`, `Needs attention`, `Connecting`, and `Not connected`.
- Avoid leaking raw provider tokens into normal UI or unprotected broker routes.
- Keep remote custody encrypted at rest inside the broker.
- Keep the existing local keychain-backed profile model for the current sync engine.

## Non-Goals

- Replacing the current local Linear token/profile model with broker-proxied execution.
- Generalizing remote encrypted custody to all providers in this pass.
- Exposing remote/local implementation detail in standard desktop UX.

## Approaches Considered

### 1. Repair-only OAuth replay

Keep remote connection state as metadata only. When local access is missing, force the user back through Linear OAuth again.

Pros:
- Small change.

Cons:
- Does not solve cross-Mac portability.
- Keeps provider reconnect as the only recovery mechanism.
- Conflicts with the desired Hack-account-owned connection model.

### 2. Broker-held encrypted token custody with protected local seeding (recommended)

Persist the Linear token envelope encrypted against the Hack-owned remote connection record. Expose a protected broker endpoint that decrypts, refreshes if needed, and returns a claimable local envelope to authenticated clients. CLI and desktop import that envelope into local keychain-backed profiles.

Pros:
- Solves the real portability gap.
- Preserves the current local sync engine.
- Keeps the normal UI simple.
- Sets up the same pattern for future remote env/secret portability work.

Cons:
- Requires broker schema/config changes and secure encryption handling.
- Requires keeping the remote stored envelope fresh when local refresh rotates tokens.

### 3. Broker-proxied Linear API execution

Never seed local access. Route Linear sync work through the broker.

Pros:
- Hides provider tokens from Macs.

Cons:
- Major architecture change.
- Pulls the sync engine into the broker.
- Too much scope for this ticket.

## Recommended Design

Adopt approach 2.

The broker should store an encrypted Linear token envelope alongside the Hack-owned connection record. That encrypted envelope becomes the source for reseeding local access on any signed-in Mac. The desktop and CLI still store local keychain-backed profiles because the existing sync engine expects them, but the user-facing contract becomes straightforward:
- `Connected`: Hack has the account and this Mac has local access.
- `Needs attention`: Hack has the account, but this Mac needs local access repaired.
- `Connecting`: OAuth flow is currently in progress.
- `Not connected`: no Hack-owned Linear account exists.

## Architecture

### Broker storage

Extend `linear_connections` with encrypted provider token custody fields. The stored payload should contain:
- access token
- access token expiry
- refresh token
- refresh token expiry
- last updated timestamp

The payload should be encrypted using a dedicated broker encryption key from environment configuration. The broker should never expose the encrypted payload directly.

### Broker endpoints

Add a protected broker endpoint for reseeding local access, keyed by `profileId` and constrained by Better Auth ownership checks. The endpoint should:
- look up the Hack-owned Linear connection
- decrypt the stored envelope
- refresh it first if the access token is missing or close to expiry and a refresh token exists
- persist the refreshed encrypted envelope back to the connection row if rotation happened
- return a plain claim payload only to the authorized caller

Add a protected broker endpoint to update the stored envelope from a local client after local refresh rotates credentials.

### Callback flow

During successful Linear callback completion:
- persist/update the Hack-owned connection row
- persist/update the encrypted token envelope on that row
- mark the flow complete for immediate local claim

This keeps the browser flow fast for the Mac that initiated it while also establishing durable remote custody.

### CLI/local profile behavior

Add a CLI command that imports local Linear access from the broker-held connection state into the existing keychain-backed profile. It should reuse the current `saveLinearToken()` path so the local sync engine remains unchanged.

Local token refresh should also push the refreshed envelope back to the broker when the profile still has broker-owned access. That keeps the remote stored envelope current and avoids reseeding stale refresh tokens later.

### Desktop UX

The Linear settings page should derive one flattened state per profile row:
- `Connected`
- `Connecting`
- `Needs attention`
- `Not connected`

If a Hack-owned connection exists but the local profile lacks a resolved token, show a single repair action such as `Repair access`. Do not expose `remote` vs `local` wording in the default row chrome.

## Failure Handling

If remote token custody is unavailable or corrupted:
- the broker seed endpoint should return a controlled error
- the desktop should map it to `Needs attention`
- the repair action should fall back to full reconnect only if reseeding cannot work

If refresh fails because the stored refresh token is revoked:
- mark the seed response as a repair failure
- keep the connection row, but show reconnect-required state

## Testing

### Broker
- connection callback persists encrypted token custody
- seed endpoint returns decrypted envelope only for authorized owners
- seed endpoint refreshes stale tokens and updates remote custody
- update endpoint replaces stored custody after local refresh
- missing encryption key fails safely

### CLI
- import-from-broker stores local token envelope in the selected profile
- refreshed local tokens sync custody back to the broker when broker-owned access exists
- normal local-only profiles keep working unchanged

### Desktop
- remote connection plus missing local token maps to `Needs attention`
- repair action imports local access and flips the row to `Connected`
- no more `0 provider accounts` when Hack already owns the account
