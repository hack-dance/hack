# Linear Integration Architecture (Manual-First)

This architecture keeps hack tickets lightweight while supporting bidirectional sync with Linear.

The detailed field, authority, and conflict rules now live in
`docs/plans/2026-03-22-linear-normalized-sync-semantics-design.md`.

## Goals

1. Support multiple Linear accounts/profiles.
2. Bind each hack project to a default Linear profile + project/team.
3. Keep sync manual by default (`sync-issue`, `sync-project`) before enabling autosync.
4. Preserve normalized provenance metadata (`owner`, `source`, `external*`, `tags`) on every synced ticket.
5. Support dependency translation (Linear parent/sub-issue -> hack `dependsOn`).

## Surfaces

1. CLI:
   - `hack linear connect|oauth-connect|profiles|use`
   - `hack linear project-bind`
   - `hack linear sync-issue --from linear|hack`
   - `hack linear sync-project --from linear|hack --owner hack|linear|both`
2. Mac app:
   - Uses the same extension commands and profile/project routing config.
3. Auth broker (`services/auth-broker`):
   - OAuth callback page: `/linear/callback`
   - Webhook ingest: `/linear/webhooks` (legacy alias: `/v1/integrations/linear/webhook`)
   - Provider discovery includes Linear OAuth + webhook metadata.

## Ticket Ownership + Provenance

Synced tickets always carry explicit ownership and lineage metadata:

1. `source`: immutable origin system (`hack` or `linear`); this is the authority signal.
2. `owner`: current working-side affinity (`hack` or `linear`); useful for selection and review, but not authority.
3. `tags`: optional label/category parity (when label sync enabled).
4. `externalSystem`, `externalId`, `externalKey`, `externalUrl`, `externalProjectId`, `externalProjectName`, `externalTeamId`.

This guarantees filtering by local-only, Linear-only, or mixed sets without ambiguous state.

## Sync Mapping

1. Status:
   - Linear `completed`/`canceled` -> hack `done`
   - Linear `started` -> hack `in_progress`
   - Linear `unstarted` -> hack `open`
   - Hack `blocked` projects to the nearest Linear `started` state and should be treated as a lossy compatible mapping, not a perpetual conflict.
2. Dependencies:
   - Linear parent/sub-issue links map to the primary hack `dependsOn` entry when dependency sync is enabled.
3. Labels:
   - Optional (`sync.labels=false` by default) to keep tickets lightweight until needed.
4. Authority:
   - `source` decides whether Hack or Linear owns authoritative fields after link.
   - `owner` does not override `source`.

## Config

### CLI / extension

- `controlPlane.extensions["dance.hack.linear"].config.defaultProfile`
- `controlPlane.extensions["dance.hack.linear"].config.profiles`
- `controlPlane.routing.overrides.linear.profile|projectId|projectName|teamId`
- `controlPlane.extensions["dance.hack.linear"].config.sync.labels|statuses|dependencies|projects`

### Auth broker / Railway env

- `HACK_LINEAR_CLIENT_ID`
- `HACK_LINEAR_SECRET` (optional with PKCE)
- `HACK_LINEAR_DEVELOPER_APP_TOKEN` (optional, for agent/system automation)
- `HACK_LINEAR_WEBHOOK_SECRET`
- `HACK_LINEAR_REDIRECT_URI` (default `/linear/callback`)
- `HACK_LINEAR_WEBHOOK_PATH` (default `/linear/webhooks`)

## Rollout Plan

1. Phase 1 (current): manual sync only, explicit one-off operations.
2. Phase 2: webhook-driven candidate updates (still gated/manual apply).
3. Phase 3: selective autosync per project/profile with conflict policies.
