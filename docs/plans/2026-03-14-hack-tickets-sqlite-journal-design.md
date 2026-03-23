# Hack Tickets SQLite Projection And Journal Design

## Goal

Define a durable local storage architecture for Hack Tickets that keeps the git-backed JSONL journal as the canonical, portable source of truth while adding a deterministic SQLite projection for fast reads, sync queries, and repeated replay.

## Inputs

- Linear issue: `HACK-450`
- Relevant spec: Tickets Normalization And Storage Spec

## Current Foundation

- Ticket history is stored as append-only monthly JSONL segments in `.hack/tickets/git/worktree/.hack/tickets/events/events-YYYY-MM.jsonl`.
- The tickets ref is transported through git, so the system already has good offline and multi-machine portability.
- Reads currently parse the full journal and materialize ticket state in memory on demand.
- Sync-oriented reads such as external id lookup, conflict lookup, and checkpoint lookup are derived by replaying every event.

## Design Summary

- Keep the JSONL journal in the tickets git ref as the only portable source of truth.
- Add a local SQLite database as a projection and replay index, not as a second authority.
- Make replay idempotent by event identity first and deterministic by a total ordering key second.
- Allow the projection to be deleted and rebuilt entirely from journal files at any time.
- Treat recovery as a normal path: if the projection is missing, stale, corrupted, or on an old schema, rebuild it from the journal.

## Non-Goals

- Do not replace the git-backed journal with SQLite.
- Do not require SQLite files to sync through git.
- Do not introduce mutable event updates, event compaction that changes meaning, or snapshot files that become a new source of truth.
- Do not redesign ticket semantics beyond what is needed for deterministic replay and indexed reads.

## Alternatives Considered

### Recommended: journal as source of truth, SQLite as local projection

This keeps portability and inspectability in git while solving the current replay cost for reads and sync. It also gives a clean recovery story because the projection is disposable.

### Rejected: SQLite as the primary store with git export/import

This would improve local read performance, but it would weaken the current portability model and create a second system boundary around export timing, merge semantics, and operational recovery.

### Rejected: keep pure JSONL replay and optimize the in-memory materializer

This avoids a new storage layer, but it does not materially improve cold-start reads, repeated sync scans, or future richer queries such as open conflicts by provider or external id lookup.

## Storage Layout

### Canonical journal

Keep the existing git-backed journal layout inside the tickets ref worktree:

- `.hack/tickets/git/worktree/.hack/tickets/events/events-YYYY-MM.jsonl`

Each line remains one immutable event envelope:

- `eventId`
- `ts`
- `tsIso`
- `actor`
- `orderKey?`
- `projectId?`
- `projectName?`
- `ticketId`
- `type`
- `payload`

### Local-only projection

Add a local SQLite file outside the synced tickets worktree:

- `.hack/tickets/state/projection.sqlite`

Companion files that are safe to delete:

- `.hack/tickets/state/projection.sqlite-shm`
- `.hack/tickets/state/projection.sqlite-wal`

This directory should stay local-only and be ignored by both the main repo and the tickets ref.

## Journal Semantics

### Source of truth

The journal is authoritative. SQLite is derived state. If the two disagree, the journal wins and the projection must be rebuilt or repaired.

### Append-only rule

Published events are immutable. The only allowed rewrite is semantic-preserving normalization during sync:

- remove duplicate lines with the same `eventId`
- keep exactly one payload for a given `eventId`
- rewrite segment ordering into the canonical replay order

### Event identity

`eventId` is the logical identity of an event across machines. Reapplying the same `eventId` is a no-op if the payload hash matches.

If the same `eventId` appears with different content, that is corruption, not conflict. Replay must stop and report the bad event ids instead of guessing.

### Canonical replay order

Replay uses this total order:

1. `ts` ascending
2. `orderKey` ascending when present
3. `eventId` ascending

Current writers already stamp `orderKey`, so the projection can preserve same-second local append sequence once it owns replay ordering. The `eventId` fallback exists for legacy rows or any imported events that are missing `orderKey`.

Today’s JSONL normalizer still rewrites files by `ts` and `eventId`. Part of this projection work is to make replay and future normalization agree on the stronger `ts` / `orderKey` / `eventId` ordering.

This order is deterministic across machines and rebuilds once the projection exists, even when segment files were merged from multiple writers. Segment filename and line number are recorded for diagnostics and incremental scanning, but they are not part of domain ordering.

### Idempotency rule

Applying an event more than once must have the same effect as applying it once.

The projection enforces this by inserting the event envelope into `journal_events` first. If the insert conflicts on `event_id`, replay compares the stored payload hash:

- same hash: skip as already applied
- different hash: stop replay and mark the projection unhealthy

## SQLite Projection Schema

### Projection metadata

`projection_meta`

- `key TEXT PRIMARY KEY`
- `value TEXT NOT NULL`

Required keys:

- `schema_version`
- `journal_format_version`
- `projection_status` with values `ready` or `rebuilding`
- `last_scan_completed_at`
- `last_replayed_ts`
- `last_replayed_order_key`
- `last_replayed_event_id`
- `last_replayed_at`

### Replay index

`journal_events`

- `event_id TEXT PRIMARY KEY`
- `ticket_id TEXT NOT NULL`
- `ts INTEGER NOT NULL`
- `ts_iso TEXT NOT NULL`
- `order_key TEXT`
- `actor TEXT NOT NULL`
- `project_id TEXT`
- `project_name TEXT`
- `type TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `payload_hash TEXT NOT NULL`
- `segment_name TEXT NOT NULL`
- `segment_line INTEGER NOT NULL`
- `applied_at TEXT NOT NULL`

Indexes:

- `journal_events_ticket_order_idx (ticket_id, ts, order_key, event_id)`
- `journal_events_type_idx (type, ts, event_id)`
- `journal_events_project_idx (project_id, ts, event_id)`

This table is the durable idempotency fence and powers fast `show` queries without reparsing JSONL.

### Segment scan inventory

`journal_segments`

- `segment_name TEXT PRIMARY KEY`
- `content_hash TEXT NOT NULL`
- `byte_size INTEGER NOT NULL`
- `line_count INTEGER NOT NULL`
- `scanned_at TEXT NOT NULL`

This table tracks which journal segment bytes have already been scanned into the projection. Replay correctness must not rely on the last applied sort key alone because a merged segment can introduce older events that sort before the current replay cursor. If the current journal inventory ever drops a segment that was previously scanned, startup must treat that as source-of-truth drift and rebuild from the remaining journal bytes so removed history does not linger in SQLite.

### Ticket projection

`tickets`

- `ticket_id TEXT PRIMARY KEY`
- `title TEXT NOT NULL`
- `body TEXT`
- `status TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `owner TEXT NOT NULL`
- `source TEXT NOT NULL`
- `assignee TEXT`
- `external_system TEXT`
- `external_id TEXT`
- `external_key TEXT`
- `external_url TEXT`
- `external_project_id TEXT`
- `external_project_name TEXT`
- `external_team_id TEXT`
- `project_id TEXT`
- `project_name TEXT`
- `last_event_id TEXT NOT NULL`

Indexes:

- `tickets_status_updated_idx (status, updated_at DESC)`
- `tickets_project_updated_idx (project_id, updated_at DESC)`
- `tickets_external_lookup_idx (external_system, external_id)`
- `tickets_source_status_idx (source, status, updated_at DESC)`

### Multi-value projections

`ticket_dependencies`

- `ticket_id TEXT NOT NULL`
- `depends_on_ticket_id TEXT NOT NULL`
- `PRIMARY KEY (ticket_id, depends_on_ticket_id)`

`ticket_blocks`

- `ticket_id TEXT NOT NULL`
- `blocks_ticket_id TEXT NOT NULL`
- `PRIMARY KEY (ticket_id, blocks_ticket_id)`

`ticket_tags`

- `ticket_id TEXT NOT NULL`
- `tag TEXT NOT NULL`
- `PRIMARY KEY (ticket_id, tag)`

Indexes:

- `ticket_dependencies_depends_idx (depends_on_ticket_id, ticket_id)`
- `ticket_blocks_blocks_idx (blocks_ticket_id, ticket_id)`
- `ticket_tags_tag_idx (tag, ticket_id)`

`ticket_blocks` stores the effective blocker edges exposed by reads, not just the explicit `blocks` payload field. To preserve current ticket semantics, replay must materialize `ticket.blocks` as the union of:

- explicit `blocks` values written on that ticket
- reverse `dependsOn` edges from other tickets that depend on this ticket

That matches the current in-memory materializer, where blockers are derived from both direct `blocks` fields and reverse dependencies.

### Append-only child entities

`ticket_comments`

- `comment_id TEXT PRIMARY KEY`
- `ticket_id TEXT NOT NULL`
- `body TEXT NOT NULL`
- `source TEXT NOT NULL`
- `actor TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `external_id TEXT`
- `external_url TEXT`
- `last_event_id TEXT NOT NULL`

`ticket_review_notes`

- `note_id TEXT PRIMARY KEY`
- `ticket_id TEXT NOT NULL`
- `body TEXT NOT NULL`
- `actor TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `context TEXT`
- `last_event_id TEXT NOT NULL`

`ticket_sync_checkpoints`

- `checkpoint_id TEXT PRIMARY KEY`
- `ticket_id TEXT NOT NULL`
- `provider TEXT NOT NULL`
- `profile_id TEXT`
- `direction TEXT`
- `remote_cursor TEXT`
- `remote_updated_at TEXT`
- `local_updated_at TEXT`
- `actor TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `last_event_id TEXT NOT NULL`

`ticket_sync_conflicts`

- `conflict_id TEXT PRIMARY KEY`
- `ticket_id TEXT NOT NULL`
- `provider TEXT NOT NULL`
- `field TEXT NOT NULL`
- `status TEXT NOT NULL`
- `authority TEXT`
- `summary TEXT`
- `local_value_json TEXT`
- `remote_value_json TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `resolution TEXT`
- `resolution_summary TEXT`
- `resolved_at TEXT`
- `resolved_by TEXT`
- `last_event_id TEXT NOT NULL`

Indexes:

- `ticket_comments_ticket_created_idx (ticket_id, created_at, comment_id)`
- `ticket_review_notes_ticket_created_idx (ticket_id, created_at, note_id)`
- `ticket_sync_checkpoints_lookup_idx (ticket_id, provider, profile_id, created_at DESC)`
- `ticket_sync_conflicts_open_idx (status, provider, updated_at DESC)`
- `ticket_sync_conflicts_ticket_idx (ticket_id, updated_at DESC)`

## Replay Rules

### Startup path

1. Open SQLite in WAL mode.
2. Read `projection_meta`.
3. If the file is missing, `schema_version` is wrong, `journal_format_version` is wrong, status is `rebuilding`, or SQLite reports corruption, delete and rebuild.
4. Otherwise compare the current segment inventory against `journal_segments`. If any previously scanned segment is now missing, rebuild from scratch. Fully rescan any segment whose bytes changed or that was not seen before.
5. Inspect newly discovered events from those segments in canonical replay order.
6. If every new event sorts strictly after the current replay cursor, append incrementally.
7. If any new event sorts at or before the current replay cursor, rebuild instead of trying to patch mutable state out of order.

### Incremental replay

Incremental replay is only valid for monotonic tail growth. It works when new events gathered from changed segments all sort strictly after the current replay cursor.

For each candidate journal line in canonical order:

1. Parse and validate the event envelope.
2. Start a transaction.
3. Insert into `journal_events`.
4. If the insert is a duplicate with the same hash, commit a no-op transaction.
5. If it is new, apply the event to the relevant projection tables.
6. Update `projection_meta` with the last applied sort key for diagnostics and crash resume.
7. Commit.

After a segment scan finishes, update `journal_segments` with the segment fingerprint in a separate transaction boundary only after all of that segment's candidate events were processed successfully.

If a changed segment introduces a newly discovered event that sorts before already applied mutable events, replay must not rely on `journal_events` dedupe alone. In that case the correct behavior is to rebuild from journal bytes rather than apply the older event after newer state mutations.

This keeps replay crash-safe, allows progress to resume from the last committed event, and avoids converging to the wrong state after multi-machine merges.

### Event application rules

- `ticket.created`: insert a row into `tickets`, replace dependency/tag sets from payload, recompute effective blocker rows for the touched ticket and any tickets referenced by its dependency edges, and set `created_at` and `updated_at` from the event timestamp.
- `ticket.updated`: patch only provided fields, replace dependency/tag sets only when they appear in payload, recompute effective blocker rows whenever explicit `blocks` or dependency edges change, and set `updated_at`.
- `ticket.status_changed`: update `status` and `updated_at`.
- `ticket.comment_appended`: insert into `ticket_comments`.
- `ticket.comment_linked`: patch `external_id` and `external_url` for the existing comment row.
- `ticket.review_note_appended`: insert into `ticket_review_notes`.
- `ticket.sync_checkpoint_recorded`: insert into `ticket_sync_checkpoints`.
- `ticket.sync_conflict_recorded`: insert into `ticket_sync_conflicts` with `status = open`.
- `ticket.sync_conflict_resolved`: patch the matching conflict row to a resolved state.

If an event references missing local state that should already exist, replay stops with a projection error instead of silently inventing rows.

## Rebuild And Recovery

### Full rebuild

Full rebuild is deterministic:

1. Delete or move aside the SQLite file.
2. Recreate schema.
3. Mark `projection_status = rebuilding`.
4. Replay every journal segment in canonical order.
5. Populate `journal_segments` for the scanned segment set.
6. Mark `projection_status = ready`.

Given the same journal bytes, rebuild produces the same projection rows and indexes every time.

### Crash recovery

Crash recovery relies on SQLite transactions and WAL:

- a half-applied event rolls back automatically
- committed events remain durable
- the replay cursor only advances in the same transaction as the projection updates
- `journal_segments` is only advanced after a successful segment scan

If the process dies mid-rebuild, the next startup sees `projection_status = rebuilding` and starts a clean rebuild rather than trusting partial state.

### Corruption recovery

Recoverable failures:

- missing SQLite file
- outdated projection schema
- outdated journal format version
- WAL or database corruption

Unrecoverable without operator action:

- malformed JSONL that cannot be parsed
- duplicate `eventId` with different payload hashes
- event references to impossible prior state caused by journal corruption

In recoverable cases, automatically rebuild. In unrecoverable cases, surface a hard error with the offending segment and line number.

## Sync And Query Benefits

The projection specifically accelerates:

- `tickets list` by reading `tickets` plus indexed filters
- `tickets show` by reading one ticket and its child tables
- `tickets show --json` by reading the ticket projection, child projections, and `journal_events`
- `tickets inspect` or equivalent health queries later by reading projection metadata instead of rescanning JSONL
- external sync lookup by `external_system` and `external_id`
- checkpoint lookup by provider and profile
- conflict review queries such as open conflicts by provider, project, or ticket
- repeated daemon or autosync loops that need to ask “what changed since cursor X?”

## Multi-Machine Behavior

- Multiple machines can append semantically equivalent journals and later merge through git.
- Normalization merges by `eventId` union, not by trusting file order.
- Journal normalization and projection replay must use the same `ts` / `orderKey` / `eventId` ordering so same-second events do not materialize differently before and after `sync`.
- Projection replay is safe after repeated fetch, merge, or sync because tail-only additions replay incrementally while historical insertions force rebuild instead of out-of-order mutation.
- Because SQLite is local-only, machines never need to coordinate projection files. They only need the same journal bytes.

## Implementation Notes

- Use `bun:sqlite` for the projection layer.
- Keep journal parsing and replay in one module so rebuild and incremental apply share the same code path.
- Expose a small health surface later, for example `tickets inspect` or `tickets rebuild`, but keep those commands out of this design’s critical path.

## Validation

- Rebuilding from the same journal twice yields byte-equivalent query results.
- Reapplying the same merged journal does not duplicate comments, checkpoints, or conflicts.
- Merging a segment that contains older events than the current replay cursor still converges because the projection detects the historical insertion and rebuilds instead of applying it out of order.
- Removing or replacing a scanned segment converges because startup treats missing segment inventory as a rebuild trigger.
- Deleting the SQLite file does not lose ticket history.
- Sync-heavy reads stop scanning all JSONL files on each command.
- Tickets that are only blocked through reverse `dependsOn` edges still surface the same effective `blocks` list after reads move to SQLite.
- `ticket.status_changed` continues to drive the visible ticket status and `updated_at` once reads are served from the projection.
- Duplicate `eventId` with mismatched payload is detected as corruption.

## Recommendation

Implement the projection as a local SQLite cache with `journal_events` as the idempotent replay fence and the `tickets` plus child tables as the read model. This gives deterministic rebuilds, fast reads, and safe repeated event application without weakening the current git-portable journal architecture.
