# Linear Sync UX Design

## Goal
Add a macOS UX pass for Linear sync that makes authority, merge behavior, and review expectations obvious without changing the underlying git-backed ticket store.

## Decisions
- Tickets remain git-backed JSON/event-log state.
- Sync ownership is origin-derived: `hack` or `linear`.
- Comments are append-only, immutable, FIFO.
- Authoritative fields: title, body/description, status, project binding.
- Mergeable fields: assignee, labels, dependencies/sub-issues.
- Conflicts are only surfaced when both sides changed an authoritative field since last sync.
- Mergeable-field ambiguity should be shown as review-needed state, not silently overwritten.
- Best-effort assignee sync is allowed, but ambiguous identity matches must not auto-apply.

## UX Direction
- Reuse existing app patterns:
  - global status strip for broad command progress
  - inline callouts for screen-specific sync policy and action results
  - disabled/loading button states for in-flight operations
- Add clear policy copy where sync actions live:
  - Tickets tab: what pull/push will do, which side is authoritative, what is append-only
  - Project routing: project-level authority and review expectations
  - Settings: global sync contract and current limits
- Add lightweight review scaffolding now, not full conflict-resolution infrastructure:
  - authority badges from origin/source metadata
  - linked/mergeable state hints
  - review-needed messaging for ambiguous fields and future authoritative conflicts
  - action confirmations that explain what will sync before the command runs

## Non-Goals
- No migration from git-backed tickets to SQLite.
- No full field-level conflict engine in this pass.
- No editable ownership override in this pass.
- No comment edit/delete synchronization.

## Storage Direction
If sync metadata grows, prefer a future SQLite sidecar for sync metadata only:
- sync shadow state
- conflict records
- identity mappings
- comment dedupe cursors
- dependency translation cache

Do not migrate ticket source-of-truth storage in this pass.
