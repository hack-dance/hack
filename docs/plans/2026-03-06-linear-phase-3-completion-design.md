# Linear Phase 3 Completion Design

## Goal
Finish the remaining production gaps in the Linear integration: team-scoped broker access control, first-class ownership persistence, shared repo-backed review notes, and opt-in project autosync built on the existing manual-first workflow.

## Existing State
- Linear OAuth, token refresh, connection persistence, webhook verification, and pending-delivery persistence are live in `services/auth-broker`.
- Broker ownership is currently user-scoped or active-organization-scoped, but team-level enforcement is not implemented.
- Organization ownership is stored pragmatically inside connection metadata and webhook payload envelopes rather than dedicated DB columns.
- The macOS app has a real review queue and local-only review notes, but those notes do not travel with git-backed ticket history.
- Manual sync remains the source of truth for applying Linear changes. Webhooks produce pending deliveries but are not auto-applied.

## Approved Direction
Review notes should be repo-shared ticket events, not broker-side records.

That yields a clean boundary:
- Repo-shared ticket state:
  - conflict records
  - conflict resolutions
  - review notes
  - manual apply/audit notes
- Broker-scoped integration state:
  - OAuth connections
  - webhook deliveries
  - assignee mappings
  - autosync subscriptions
  - user/org/team ownership metadata

Review notes must stay distinct from synced ticket comments. They should be append-only Hack review events and must not post to Linear unless we explicitly add that later.

## Design Decisions

### 1. Team-scoped broker authz
Broker Linear routes should move from:
- unauthenticated/public metadata for provider discovery
- authenticated user/org ownership for connection and delivery records

to:
- user ownership fallback only when no org/team scope exists
- org ownership when the active Better Auth organization is present
- team ownership enforcement for routes that list or mutate connection/delivery state when a record is team-scoped

This should apply to:
- `/v1/auth/linear/connections`
- `/v1/auth/linear/deliveries`
- `/v1/auth/linear/deliveries/:id/apply`
- future autosync subscription routes

### 2. First-class ownership schema
Move ownership fields out of JSON blobs/envelopes and into dedicated persisted columns.

Needed broker-side fields:
- `betterAuthOrganizationId`
- `betterAuthTeamId`

Tables affected:
- `linear_connections`
- `linear_webhook_events`
- `linear_sync_subscriptions`
- `linear_assignee_mappings` should also support team scoping if not already first-class

The auth-broker service still needs to remain deployable in Railway’s isolated Docker image, so the service-local DB schema/client must stay self-contained or copy-safe.

### 3. Shared repo-backed review notes
Add a new append-only ticket event such as:
- `ticket.review_note_appended`

Properties:
- repo-shared in the git-backed ticket history
- separate from synced comments
- includes author/source metadata and timestamp
- visible in ticket detail and review queue
- can optionally carry an `origin` or `context` like `manual_apply`, `conflict_review`, `assignee_resolution`

This is the right place for human reconciliation notes and audit context around manual sync decisions.

### 4. Project autosync
Autosync should remain opt-in and project-scoped.

Model:
- webhook deliveries continue to land in the broker as pending events
- autosync subscription config enables automatic application for matching project/profile/team routes
- autosync uses the same sync engine as manual apply
- unresolved authority conflicts, ambiguous assignee mapping, or dependency translation failures should not silently overwrite; they should record review/conflict state and stop short of destructive mutation

Autosync should preserve the manual-first contract:
- default off
- explicit per-project enablement
- observability into what was auto-applied vs queued for review

## Execution Order
1. Promote ownership to first-class schema and data access
2. Enforce team-level authz using those first-class fields
3. Add shared repo-backed review notes and wire them into CLI/macOS review flow
4. Add project-scoped autosync subscriptions and worker/apply flow

## Risks
- Schema changes in auth-broker must not break Railway deployment packaging.
- Team membership resolution depends on Better Auth session shape and may require careful compatibility handling.
- Repo-shared review notes must avoid being mistaken for synced ticket comments.
- Autosync can create noisy review state if the conflict boundary is too aggressive; keep it conservative.

## Testing Expectations
- auth-broker route tests for user/org/team visibility and mutation rules
- auth-broker store tests for first-class ownership columns
- ticket store tests for review-note event materialization
- CLI tests for review-note append/list and autosync subscription/apply commands
- macOS model/UI tests for shared review-note rendering and autosync status surfaces
