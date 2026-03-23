# Tickets Normalization Core Design

## Program Outcome

This program ticket does not attempt to land the full normalization rewrite in one branch. Its implementation outcome is:

- a repo-visible design that makes storage direction, sync direction, and normalized entities explicit
- a concrete child-workstream breakdown for storage, provenance, sync, and documents
- hidden-ref ticket records that preserve the work breakdown inside Hack Tickets itself

The functional implementation should land incrementally through the child tickets rather than as an all-at-once migration under `HACK-431`.

## Context

Hack Tickets already has a useful local-first shape:

- append-only JSONL events under `.hack/tickets/events/`
- git portability via the dedicated tickets ref managed by `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- an in-memory materialized store in `src/control-plane/extensions/tickets/store.ts`
- sync metadata already embedded in ticket records through `external*`, checkpoint, conflict, and review-note events

That is enough for manual workflows and the current Linear integration, but it leaves a structural gap:

- the normalized ticket entity is implicit in event reducers instead of being a first-class model
- provenance is spread across ad hoc fields instead of a consistent identity/change-authority model
- materialization is process-local rather than durable
- richer ticket documents are flattened into `body` instead of being tracked as typed projections

This stream should make Tickets the canonical normalized work model without losing the properties that already matter:

- local-first operation
- git portability
- hidden-ref sync
- append-only auditability
- compatibility with current ticket commands and integrations

## Goals

- Define an explicit normalized ticket entity and provenance model.
- Introduce a durable SQLite projection fed by the append-only journal.
- Keep the journal and hidden-ref sync as the portable source format.
- Make sync direction and conflict semantics explicit and idempotent.
- Add a path for markdown-backed ticket documents and specs as first-class records.

## Non-Goals

- Replacing git-backed event storage with SQLite as the transport format.
- Building every downstream integration in this ticket.
- Changing the current CLI UX beyond what is needed to expose the normalized model.
- Introducing rich-text or binary document storage in the first normalization pass.

## Current State

Today the source of truth is effectively:

1. append JSONL events to `.hack/tickets/events/events-YYYY-MM.jsonl`
2. normalize and sync those logs through `tickets-git-channel.ts`
3. read all events into memory and materialize `TicketSummary`, comments, review notes, checkpoints, and conflicts in `store.ts`

That model is simple and portable, but it conflates three concerns:

- journal transport
- normalized domain state
- process-local query projection

The result is that sync and provenance rules exist, but they are encoded as reducer behavior instead of a documented durable model.

## Approaches Considered

### 1. Keep JSONL-only and improve reducer structure

Pros:

- lowest migration cost
- preserves current portability

Cons:

- no durable local projection
- expensive cold reads keep growing with log size
- provenance and document support stay implicit

### 2. Make SQLite the new primary store and export JSONL from it

Pros:

- simpler local querying
- easier relational modeling

Cons:

- portability becomes derived instead of native
- hidden-ref sync becomes a secondary export path
- raises trust questions around journal determinism and merge behavior

### 3. Keep the append-only journal as canonical, add a deterministic SQLite projection, and model normalized entities/provenance explicitly

Pros:

- preserves local-first git portability
- gives durable query performance
- makes sync semantics and document support explicit
- allows idempotent rebuild from journal at any time

Cons:

- two storage layers to maintain
- needs careful projection versioning and replay semantics

### Recommendation

Choose option 3.

The journal should remain the canonical transport and audit format. SQLite should be a deterministic projection cache plus query layer, never the only copy of portable ticket state.

## Proposed Model

### Source-of-truth direction

The storage direction should be explicit:

1. Commands and integrations append normalized events to the journal.
2. The journal is the portable canonical record synced through the hidden git ref.
3. SQLite is rebuilt or incrementally updated from journal events.
4. Read paths prefer SQLite once present, with replay fallback if projection state is absent or stale.

This keeps portability intact while removing the requirement that every read rebuild state from scratch.

### Layering

#### 1. Journal layer

Stored under `.hack/tickets/events/` as append-only JSONL segments.

Responsibilities:

- preserve all state transitions as immutable facts
- remain mergeable and git-syncable
- carry enough event metadata for deterministic projection

Required additions:

- explicit journal envelope version
- stable event ids for idempotent replay
- causality metadata for external sync events
- typed document events instead of overloading `ticket.updated` body changes

#### 2. Normalized domain layer

New first-class model for:

- ticket identity
- ticket fields
- provenance and authority
- external links and remote mappings
- typed documents
- sync checkpoints and conflicts

This layer is conceptual and code-level. It should not depend on whether the backing read path is replay or SQLite.

#### 3. SQLite projection layer

Stored locally under `.hack/tickets/` as a rebuildable projection database.

Responsibilities:

- durable materialized reads
- indexed lookup by ticket id, external identity, status, assignee, project, and updated time
- document lookup and search metadata
- replay bookkeeping for incremental projection

SQLite is not a sync target. If deleted, it must be recreated from the journal without losing correctness.

## Normalized Entities

### Ticket

Core ticket row with stable Hack identity:

- `ticket_id`
- `project_id`
- `project_name`
- `status`
- `title`
- `current_document_id`
- `created_at`
- `updated_at`
- `closed_at`

This should no longer carry every remote-specific field directly. Remote linkage belongs in provenance tables.

### Ticket provenance

Explicit provenance should answer:

- where this ticket originated
- which system owns which field
- which remote objects correspond to this local ticket
- which event last changed a field

Recommended normalized concepts:

- `ticket_origins`
  - first local source for a ticket such as `hack` or `linear`
- `ticket_remotes`
  - one row per provider/profile/remote object link
- `ticket_field_authority`
  - per-field authority rule such as `local`, `remote`, `append_only`, `derived`, `review_required`
- `ticket_field_versions`
  - last-applied value, source event id, actor, and timestamp for conflict detection/audit

This replaces the current mixed use of `owner`, `source`, and `external*` fields as the only provenance representation.

### Ticket documents

The current `body` field should become a convenience projection over a typed document model.

Recommended normalized concepts:

- `ticket_documents`
  - immutable markdown snapshots with `document_id`, `ticket_id`, `kind`, `content_sha256`, `content`, `created_at`, `actor`
- `ticket_document_links`
  - logical roles such as `description`, `spec`, `notes`, `handoff`

`kind` should start with:

- `description`
- `spec`
- `notes`

This keeps markdown-backed ticket docs portable while allowing richer behavior later.

### Activity streams

Retain append-only records for:

- comments
- review notes
- sync checkpoints
- sync conflicts
- conflict resolutions

These can remain event-backed and project into dedicated SQLite tables with stable ids.

## Journal Envelope

Every event should project from a normalized journal envelope:

- `eventId`
- `schemaVersion`
- `eventType`
- `ticketId`
- `occurredAt`
- `recordedAt`
- `actor`
- `sourceSystem`
- `sourceOperation`
- `idempotencyKey`
- `causationId`
- `correlationId`
- `payload`

Notes:

- `eventId` and `idempotencyKey` must make replay safe.
- `occurredAt` preserves remote source ordering when known.
- `recordedAt` preserves local append time.
- `sourceOperation` distinguishes local edits, remote pulls, webhook applies, and repair flows.

## SQLite Projection

### Proposed tables

- `projection_meta`
- `journal_events`
- `tickets`
- `ticket_origins`
- `ticket_remotes`
- `ticket_field_authority`
- `ticket_field_versions`
- `ticket_documents`
- `ticket_document_links`
- `ticket_comments`
- `ticket_review_notes`
- `ticket_sync_checkpoints`
- `ticket_sync_conflicts`

### Projection rules

- Journal replay is strictly append-only by `eventId`.
- `journal_events` stores applied ids and replay metadata.
- Rebuild mode drops and recreates derived tables from journal files.
- Incremental mode applies only unseen events.
- Projection version changes trigger a rebuild.

### Read-path rules

- CLI read commands should prefer SQLite snapshots.
- If SQLite is missing or projection metadata is incompatible, rebuild from journal automatically.
- A JSONL-only fallback should remain available for recovery and tests.

## Sync Semantics

### Portable sync

Portable sync remains journal-first:

- sync pushes the journal through the hidden ref
- no SQLite files are pushed
- peers rebuild their projection locally after fetch or on first read

### Idempotent external sync

External sync must treat journal append as the local mutation boundary.

Rules:

- remote changes map to deterministic journal events
- repeated delivery of the same remote mutation must reuse the same `idempotencyKey` or remote event identity
- applying the same remote change twice must be a no-op at the projection layer
- outbound sync checkpoints must record the last remote cursor or updated-at observed per remote link

### Conflict semantics

Conflicts should become explicit policy instead of inferred behavior.

Per field, choose one of:

- `local`
- `remote`
- `append_only`
- `derived`
- `review_required`

Initial policy:

- comments: `append_only`
- review notes: `local`
- sync checkpoints: `derived`
- conflict records: `derived`
- title/status/assignee/description: provider-specific, but persisted as explicit authority rules per remote link

When a field marked `review_required` diverges, the system should:

1. append a conflict event
2. leave the current materialized value unchanged
3. require an explicit resolution event

## Markdown-Backed Ticket Documents

Markdown-backed docs should be first-class without breaking the current CLI shape.

### Storage model

- keep documents as UTF-8 markdown in the journal payload and SQLite projection
- expose the current description as the compatibility `body` projection
- allow additional docs like `spec` and `notes` to exist alongside the default description

### File materialization

The first pass should not require checked-in document files on the main branch.

Instead:

- documents live in the ticket journal and SQLite projection
- optional file export/import can come later as a projection or command

This preserves hidden-ref portability and avoids creating a second source of truth immediately.

## Migration Strategy

### Phase 1

- Introduce normalized domain types and journal envelope versioning.
- Keep current JSONL file layout.
- Add SQLite projection schema and rebuild path.
- Backfill current `TicketSummary` reads from the projection adapter.

### Phase 2

- Migrate external sync logic to provenance and authority tables.
- Introduce typed document events and compatibility body projection.

### Phase 3

- Add richer queries and optional document-oriented commands or exports.

## Child Workstreams

This program should be decomposed into four child tickets:

1. `T-00001` Storage: normalized entity schema plus SQLite projection and replay.
2. `T-00002` Provenance: ticket origin, remote identity, field authority, and field version audit model.
3. `T-00003` Sync: idempotent external sync, checkpoint semantics, and conflict policy.
4. `T-00004` Documents: markdown-backed description/spec/notes support and compatibility projection.

### Execution order

- Start with `T-00001` because it defines the normalized storage and projection contract.
- Take `T-00002` next because provenance and field authority depend on the storage shape.
- After `T-00001` and `T-00002`, `T-00003` and `T-00004` can proceed independently.

### Program completion semantics

`HACK-431` is complete when this design is landed, the implementation plan is landed, and the child tickets exist with the dependencies above. The code changes for normalization itself belong to the child tickets.

## Risks

- SQLite can accidentally become the de facto source of truth if write paths bypass the journal.
- Rebuild logic must be deterministic across machines and Bun versions.
- Existing integrations may implicitly rely on ad hoc `external*` fields and need a compatibility layer.
- Document typing can become over-designed if the first pass tries to support too many document kinds.

## Validation

The implementation should prove:

- deleting the SQLite file does not lose state
- replaying the same journal twice is idempotent
- hidden-ref sync transfers all portable ticket state without the SQLite database
- conflicting remote updates create explicit conflict rows/events
- description/spec markdown documents round-trip through journal, projection, and CLI reads

## Recommended Next Step

Implement the program as journal-first normalization, not as a database migration away from git-backed tickets.
