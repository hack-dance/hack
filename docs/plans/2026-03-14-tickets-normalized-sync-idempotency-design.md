# Tickets Normalized Sync Idempotency Design

## Goal

Define how normalized ticket sync behaves when the same external change is observed multiple times across multiple machines, while making conflicts explicit and preventing silent corruption.

## Existing State

- The tickets ref is an append-only event log stored in monthly JSONL files under `.hack/tickets/events/`.
- Ticket log merge and normalization already dedupe raw log lines by `eventId` and sort by `ts`, then `eventId`.
- The ticket store already has append-only events for sync checkpoints, sync conflicts, and sync conflict resolution.
- Current store helpers generate random ids for checkpoints and conflicts, which is fine for local writes but does not yet define a deterministic identity for the same external change replayed on different machines.
- Current Linear conflict dedupe is pragmatic and narrow. It avoids creating the same open conflict more than once for the same observed field/value pair, but it is not yet the system-wide contract for normalized sync.
- Current Linear authority is binary and ticket-scoped: `owner === "linear"` or `source === "linear"` makes Linear authoritative for the main mirrored fields; everything else is treated as Hack-authoritative.
- Current conflict detection only covers a small shared-field set: `title`, `body`, `status`, and `project`. Manual resolution records a resolution event, but it does not itself mutate either side.

## Approaches Considered

### 1. Document the current behavior as-is

Keep random sync ids and describe the current Linear-specific dedupe rules.

Why not:

- repeated logical external writes would still produce distinct checkpoint and conflict events on different machines
- correctness would continue depending on provider-specific ad hoc logic
- the normalized store would not have a cross-provider convergence contract

### 2. Add deterministic logical operation identity on top of transport dedupe

Keep the append-only event log and event-fold materialization model, but define a deterministic identity for each normalized external operation and for each materialized conflict.

Why this is the recommended direction:

- it matches the current store architecture
- it works with the existing `eventId`-based merge pipeline
- it makes multi-machine replay converge without introducing a sidecar sync database

### 3. Introduce a heavier sync shadow state or CRDT layer

Add a separate replicated sync state model with richer merge semantics.

Why not:

- it is disproportionate to the current tickets architecture
- it adds a second source of truth for sync state
- the current acceptance criteria do not require arbitrary automatic merges

## Approved Direction

Treat transport dedupe and logical sync dedupe as separate concerns.

- `eventId` is the transport-level identity. Duplicate log lines with the same `eventId` must always collapse safely.
- `operationKey` is the logical identity of a normalized external change. Every machine that observes the same remote change must derive the same `operationKey`.
- External sync writers must derive deterministic event ids from that `operationKey` so the same logical write collapses during merge, retry, and replay.
- Conflict handling must be checkpoint-based and explicit. When both sides changed and policy does not allow auto-resolution, the system records an open conflict and stops short of destructive mutation.
- This extends the current append-only store; it does not replace normalization, git-ref sync, or fold-based materialization.

## Design Decisions

### 1. Define the idempotency unit

The unit of idempotency is a normalized sync operation, not a webhook delivery, process invocation, or git commit.

Each normalized external change should derive an `operationKey` from:

- provider identity, such as `linear`
- provider profile or connection scope when relevant
- external entity kind and id, such as `issue:123`
- remote change token, version, or stable updated-at marker
- normalized mutation kind, such as `ticket.pull.field_update`
- field scope when a single remote change fans out into multiple local decisions

Example shape:

```text
linear:default:issue:LIN-123:update:2026-03-14T10:15:00.000Z:title
```

This key must be deterministic across machines. If two machines see the same remote change and derive different keys, that is a bug in the adapter.

### 2. Derive deterministic event ids from the operation

Every normalized event emitted from an external change should use a deterministic `eventId`, not a random UUID.

Recommended rule:

- build `eventId` from `operationKey` plus a stable suffix for the emitted event kind
- use one suffix per materialized effect, such as `apply`, `checkpoint`, `conflict`, or `resolution`

Example:

```text
sha256("${operationKey}:checkpoint")
sha256("${operationKey}:conflict")
```

That gives the system three safety properties:

- retrying the same write on one machine is a no-op
- replaying the same external delivery on another machine is a no-op
- merging diverged ticket refs collapses duplicate logical writes without special-case reconciliation

### 3. Keep checkpoints as the baseline for three-way decisions

Conflict decisions must be based on the last acknowledged sync baseline, not only on wall-clock timestamps.

For each synchronized field:

- the last applied checkpoint defines the remote baseline
- current local materialized state defines the local candidate
- incoming normalized external state defines the remote candidate

`remoteUpdatedAt` or provider cursors are useful evidence, but they are advisory. The baseline checkpoint is the real decision boundary.

### 4. Apply a fixed conflict matrix

For each synchronized field, normalized sync should follow this matrix:

| Condition | Behavior |
| --- | --- |
| Incoming remote value equals current local value | No-op, optionally record a fresher checkpoint |
| Only the remote side changed since the baseline | Apply the remote value and record a checkpoint |
| Only the local side changed since the baseline | Keep the local value; do not manufacture a conflict on pull |
| Both sides changed to the same normalized value | No conflict, just advance the checkpoint |
| Both sides changed to different values | Record a conflict or an explicit auto-resolution event according to field authority |
| One side cleared a value and the other edited it | Treat as a divergent two-sided change |

The important rule is that a divergent two-sided change must never silently overwrite the losing side.

### 5. Make authority decisions explicit

Each synchronized field must declare one of three authority modes. Adapters should not improvise this case-by-case.

This is intentionally stricter than the current Linear integration, which derives authority from ticket-level `owner` and `source`. Normalized sync should move authority decisions to the field contract so multi-provider behavior stays predictable.

#### External-authoritative

Use for identity and provenance fields that mirror the provider:

- external id
- external key
- external url
- provider project or team bindings

Behavior:

- remote wins
- if a local value diverged, record an explicit audit trail before or alongside the overwrite
- the resolution should be visible as `accept_remote`, not implied by absence of a conflict

#### Local-authoritative

Use for Hack-only fields that external systems do not own:

- review notes
- local workflow metadata
- machine-local or repo-local annotations that are not mirrored upstream

Behavior:

- local wins
- incoming external attempts are ignored or mapped to another field
- if needed, emit a resolved conflict or review note so the discard is visible

#### Shared-manual

Use for fields where both systems can legitimately change the value:

- title
- body
- status
- assignee
- dependency edges

Behavior:

- auto-apply one-sided changes
- when both sides changed to different values, create an open conflict and stop automatic mutation for that field
- require either a user resolution or a documented provider-specific merge rule

### 6. Make conflicts idempotent too

Conflict records need their own stable identity.

An open conflict should be unique by a deterministic `conflictKey` built from:

- ticket id
- provider
- field
- baseline checkpoint id or remote version
- local normalized value
- remote normalized value

Repeated observation of the same divergence must not create duplicate open conflicts. It should:

- return the existing open conflict if it is still unresolved
- no-op if the same conflict record is already present

When a resolution is applied:

- repeated application of the same resolution to the same open conflict must be a no-op
- a later, different divergence must create a new conflict with a new key instead of reopening the old one implicitly

### 7. Preserve convergence under multi-machine replay

The convergence contract for normalized sync is:

1. Multiple machines may append the same deterministic events.
2. Ticket log merge collapses duplicates by `eventId`.
3. Materialization is a pure fold over the normalized log.
4. Therefore every machine converges to the same ticket state after sync.

This means correctness cannot depend on:

- which machine saw the external change first
- whether a push was retried
- exact wall-clock ordering between two copies of the same logical external operation

Clock skew may change presentation order for unrelated events with similar timestamps, but it must not change conflict outcomes or authority decisions.

## Required Event Metadata

Normalized external sync events should carry enough metadata to explain why they exist and to make replay deterministic.

Recommended fields:

- `provider`
- `profileId`
- `operationKey`
- `externalEntityId`
- `externalVersion` or equivalent provider change token
- `baselineCheckpointId`
- `authority`
- `origin`, such as `manual_apply`, `autosync`, or `webhook_replay`

This metadata belongs on checkpoint, conflict, and explicit resolution events, even if some fields remain optional for local-only writes.

When available, providers should also persist the specific remote field scope that fed the operation. That keeps one remote entity update that fans out into multiple field decisions debuggable during replay.

## Guidance For Specific Cases

### Repeated webhook delivery

- Same provider event, same remote version, same normalized field change
- Derive the same `operationKey`
- Emit the same deterministic `eventId`s
- Result: safe no-op after merge or replay

### Retry after uncertain push outcome

- Reuse the same generated ids for the pending normalized events
- Do not generate fresh UUIDs on each retry
- Result: safe retry even if the first push actually landed

### Same remote change observed on two laptops

- Both laptops derive the same ids
- Both can append locally
- Later sync collapses duplicate lines by `eventId`
- Result: converged state without manual cleanup

### Divergent local and remote edit on a shared field

- Detect against the last checkpoint
- Record one open conflict with a stable `conflictKey`
- Leave the current field unchanged until the conflict is resolved
- Result: no silent overwrite

### Divergent edit on an external-authoritative field

- Record visible authority handling
- Apply the remote value
- Mark the outcome as an explicit `accept_remote` resolution
- Result: authority is enforced without hiding the disagreement

## Implementation Consequences

This design implies follow-up changes in the normalized sync core:

- external sync helpers must accept caller-provided stable ids instead of always generating random UUIDs
- checkpoint and conflict events should persist `operationKey` and baseline metadata
- conflict dedupe should move from ad hoc field/value matching to deterministic conflict keys
- conflict resolution helpers should become idempotent when the same resolution is replayed
- provider adapters must define and test their field authority map
- `tickets show --json` and related inspection surfaces should expose the new sync metadata so operators can explain why a conflict or checkpoint exists

## Non-Goals

- CRDT-style automatic merge for arbitrary ticket fields
- last-writer-wins based only on wall-clock time
- hidden authority decisions that discard one side without recording what happened

## Acceptance Criteria Mapping

- Repeated application of the same external change is safe because every machine derives the same logical operation key and deterministic event ids.
- Conflicts are detectable because each synchronized field is evaluated against a checkpoint baseline with explicit two-sided divergence rules.
- Multi-machine synchronization converges because duplicate logical writes collapse by `eventId`, while true disagreements materialize as explicit conflicts instead of silent corruption.
