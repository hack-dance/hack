# Linear Normalized Sync Semantics Design

## Goal

Define the canonical two-way sync semantics between Linear and the normalized Hack Tickets core so future manual sync, autosync, and dogfooding work share one model.

## Scope

This document covers:

- field translation between Linear issues and normalized Hack ticket records
- authority and conflict behavior for two-way sync
- the boundary between synced state, repo-shared local state, and operator-only repair

This document does not cover:

- OAuth and broker connection setup
- desktop-specific presentation details
- a new ticket storage model outside the normalized tickets event log

## Normalized Hack Ticket Contract

Linear sync targets the normalized ticket model already exposed by the tickets store:

- `TicketSummary`
  - `ticketId`, `title`, `body`, `status`
  - `dependsOn`, `blocks`
  - `owner`, `source`, `assignee`, `tags`
  - `externalSystem`, `externalId`, `externalKey`, `externalUrl`
  - `externalProjectId`, `externalProjectName`, `externalTeamId`
  - `projectId`, `projectName`
- `TicketComment`
- `TicketReviewNote`
- `TicketSyncCheckpoint`
- `TicketSyncConflict`

Two-way sync must mutate that model directly. It must not introduce a separate Linear-shaped shadow record that later gets reinterpreted into tickets.

## Canonical Identity And Provenance

### 1. Local identity

- `ticketId` is the stable Hack-local identifier.
- Linear never owns `ticketId`.
- Sync may create a ticket, but after creation all subsequent sync resolves against the existing `ticketId`.

### 2. Remote link identity

- A ticket is fully linked to Linear only when:
  - `externalSystem == "linear"`
  - `externalId` is present
- `externalId` is the authoritative remote identity.
- `externalKey` is a human-facing lookup key and fallback repair handle.
- `externalUrl` is convenience metadata only.

If `externalSystem` is `linear` but `externalId` is missing, the ticket is in a repairable partial-link state. Manual repair is required before autosync may treat it as durable.

### 3. Provenance fields

- `source` is the immutable origin system for the ticket.
  - `hack` means the ticket originated in Hack.
  - `linear` means the ticket originated in Linear.
- `owner` is the current working-side affinity for selection, filtering, and operator intent.
  - It defaults to `source` on initial create/import.
  - It may change later through explicit operator action or selection flows.
  - It does not redefine authoritative field ownership.

The key rule is simple: `source` decides authority; `owner` does not.

If `owner` and `source` diverge, the ticket remains valid but should surface a review hint because best-effort fields may now need human confirmation.

## Field Classes

### Authoritative mirrored fields

These fields sync in both directions, but only the origin side is authoritative after link:

| Hack field | Linear field | Rule |
| --- | --- | --- |
| `title` | `issue.title` | Mirror both ways. After link, `source` decides authority. |
| `body` | `issue.description` | Mirror both ways. Imported Linear bodies may include a local footer for provenance display; conflict comparison must ignore that footer. |
| `status` | `issue.state.type` | Mirror both ways through the normalized mapping below. `source` decides authority. |

### Best-effort merged fields

These fields sync when enabled, but never silently win by provenance alone:

| Hack field | Linear field | Rule |
| --- | --- | --- |
| `assignee` | `issue.assignee` | Best-effort mapping. If resolution is ambiguous, keep current value and record conflict. |
| `tags` | `issue.labels` | Best-effort when label sync is enabled. Missing labels should not destroy unrelated local provenance tags without explicit policy. |
| `dependsOn` | `issue.parentId` / parent issue | Best-effort only for the primary parent relationship. Unresolvable parents require conflict or deferred repair. |

### Linkage and routing snapshot fields

These fields describe the Linear link and should refresh from the latest successful Linear response:

| Hack field | Source | Rule |
| --- | --- | --- |
| `externalSystem` | constant | Set to `linear` once the ticket is linked. |
| `externalId` | Linear issue id | Authoritative remote identity. |
| `externalKey` | Linear issue identifier | Human-facing key. |
| `externalUrl` | Linear issue url | Convenience metadata. |
| `externalProjectId` | Linear project id | Remote placement snapshot. |
| `externalProjectName` | Linear project name | Remote placement snapshot. |
| `externalTeamId` | Linear team id | Remote routing snapshot. |

### Hack-local fields

These fields never round-trip to Linear:

| Hack field | Rule |
| --- | --- |
| `ticketId` | Local identity only. |
| `owner` | Local workflow affinity only. |
| `source` | Local provenance only. |
| `projectId`, `projectName` | Hack-local project placement. Chosen at local create/import time, not overwritten by Linear project moves. |
| `blocks` | Hack-local reverse adjacency projection. Do not sync independently. |
| `TicketReviewNote` | Repo-shared review/audit state only. Never posts to Linear. |
| `TicketSyncCheckpoint` | Repo-shared sync ledger only. |
| `TicketSyncConflict` | Repo-shared review ledger only. |

## Translation Rules

### Status mapping

Linear to Hack:

- `completed` or `canceled` -> `done`
- `started` -> `in_progress`
- `unstarted` -> `open`

Hack to Linear:

- `done` -> nearest `completed` state
- `in_progress` -> nearest `started` state
- `blocked` -> nearest `started` state
- `open` -> nearest `unstarted` state

`blocked` is a lossy Hack-local refinement. A pull from Linear cannot reconstruct it. Autosync and conflict comparison must treat `blocked` vs a synced Linear `started` state as compatible unless another authoritative status change happened.

### Dependency mapping

- Linear parent/sub-issue maps to the first entry in `dependsOn`.
- Extra Hack dependencies remain local-only until the normalized model grows a representable multi-edge remote mapping.
- `blocks` stays derived from Hack-local graph state and is never pushed to Linear as a separate concept.

### Assignee mapping

Resolution order for Hack to Linear:

1. explicit assignee mapping for the selected profile and team
2. exact email match
3. exact display-name match
4. exact username/name match

If none or more than one safe match exists:

- do not overwrite the current Linear assignee
- record a sync conflict or review-needed state
- require operator intervention

Linear to Hack may set `assignee` from the best available remote display value, but unresolved remote identity must not fabricate a stronger local mapping than the upstream data actually provides.

### Body rendering

When Linear creates or updates a Hack ticket, Hack may append a local provenance footer such as the Linear key and URL to the body rendering. That footer is a local convenience artifact, not part of the remote authoritative description. Conflict comparison and Hack-to-Linear pushes must compare against the logical body, not the rendered footer.

### Comment mapping

- Comments are append-only in both systems.
- Comment edit and delete are out of scope.
- Remote comment identity should use `externalId` when present.
- Fallback dedupe may use normalized body text only as a best-effort secondary check.
- If dedupe is not confident, stop and require operator review rather than risk duplicate reposts.

### Review notes

- Review notes are repo-shared Hack events.
- They are never mirrored to Linear comments.
- They are the canonical place to explain manual resolutions and sync decisions.

## Two-Way Sync Behavior

### Linear -> Hack create

When no linked ticket exists for a Linear issue:

- create a new Hack ticket
- set `source = "linear"`
- set `owner = "linear"` by default
- populate authoritative mirrored fields from the Linear issue
- populate best-effort fields when safely representable
- populate `external*` linkage metadata
- place the new ticket into the current Hack project context without treating the Linear project as the Hack project identity

### Linear -> Hack update

When a linked ticket already exists:

- refresh `external*` linkage metadata from Linear
- append newly discovered remote comments
- apply authoritative fields only if `source == "linear"`
- leave authoritative fields unchanged if `source == "hack"`, but record divergence for review
- update best-effort merged fields only when the translation is safe
- record a `TicketSyncCheckpoint`

### Hack -> Linear create

When a Hack ticket is not yet linked and outbound create is allowed:

- create a Linear issue in the explicitly selected or bound Linear project/team
- preserve `source = "hack"`
- preserve `owner` unless the operator explicitly changes it
- write back `external*` linkage metadata from the create response
- record a `TicketSyncCheckpoint`

### Hack -> Linear update

When a linked Linear issue already exists:

- resolve the current remote issue by `externalId`, falling back to `externalKey` only for repair
- push authoritative fields only if `source == "hack"`
- if `source == "linear"`, keep the remote authoritative fields intact and record divergence instead of overwriting
- push safe best-effort merged fields when enabled
- append newly created local comments that are not already mirrored
- refresh `external*` linkage metadata from the update response
- record a `TicketSyncCheckpoint`

## Authority And Conflicts

### Authoritative fields

The authoritative field group is:

- `title`
- `body`
- `status`

Project routing needs a split rule:

- `projectId` and `projectName` are Hack-local and are not Linear-authoritative
- `externalProjectId`, `externalProjectName`, and `externalTeamId` are Linear snapshots and are refreshed from Linear

That avoids a false equivalence between local Hack placement and remote Linear project placement.

### Conflict detection

Record a sync conflict when:

- a non-authoritative side changed an authoritative field since the last compatible checkpoint
- assignee resolution is ambiguous or missing
- a dependency target cannot be resolved safely
- comment dedupe is uncertain
- the ticket is partially linked and identity repair is required

Conflict records should capture:

- provider
- field or category
- local value summary
- remote value summary
- expected authority
- created/updated timestamps

### Conflict resolution behavior

Allowed normalized resolutions:

- `accept_local`
- `accept_remote`
- `merged`
- `ignore`

Resolving a conflict updates the conflict ledger. It does not retroactively rewrite provenance.

### Operator intervention boundary

Manual intervention is required for:

- partial links without `externalId`
- ambiguous assignee mapping
- non-representable dependency topology
- uncertain comment dedupe
- any resolution that would change `source`

Autosync must stop short of those cases and leave durable review state behind.

## Autosync Safety Rules

Autosync may apply without prompting only when all of the following are true:

- the ticket is fully linked by `externalId`
- the project/profile route is known
- authoritative comparison is unambiguous
- best-effort fields resolve safely
- comment dedupe is confident

Autosync must never:

- change `source`
- treat `owner` as authority
- post review notes to Linear
- silently clear unrepresentable dependencies
- silently overwrite open conflicts

## Implementation Consequences

The sync engine and UI should converge on these rules:

- authority is derived from `source`
- `owner` remains useful for selection and operator intent, not source-of-truth override
- `externalId` is the durable remote key
- local Hack project placement is not the same field as Linear project placement
- lossy status translation for `blocked` must not create noisy perpetual conflicts

That gives future autosync work a predictable boundary: authoritative fields stay origin-owned, best-effort fields stay mergeable, and uncertain cases leave durable review artifacts instead of silent data drift.
