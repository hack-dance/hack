# Tickets Storage Git Portability Design

## Context

Tickets already rely on git as the durable transport layer:

- the canonical ticket history is an append-only event log stored under `.hack/tickets/events`
- sync uses a dedicated tickets ref, hidden by default as `refs/hack/tickets`
- the local store rebuilds ticket summaries, comments, review notes, checkpoints, and conflicts by replaying the event log

The normalization work adds a clearer distinction between a durable journal and derived projection state. That split must not weaken the reasons tickets are useful today:

- a repo can be cloned and moved between machines without losing ticket history
- ticket work continues offline
- hidden-ref sync remains viable for existing users and existing remotes

The relevant current implementation lives in:

- `src/control-plane/extensions/tickets/store.ts`
- `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- `tests/tickets-store.test.ts`
- `tests/tickets-git-channel.test.ts`

I could not access the linked Linear spec from this workspace, so this design is anchored to the current repository behavior and the acceptance criteria in `HACK-451`.

## Goals

- Keep git as the durable, portable layer for tickets.
- Make the durable-vs-derived boundary explicit for the normalized storage model.
- Ensure projection state can be rebuilt on any machine from portable data.
- Preserve the existing hidden-ref workflow and legacy branch compatibility.

## Non-Goals

- Changing the default ref name or removing hidden refs.
- Making projection snapshots authoritative.
- Requiring users to commit local caches or git plumbing.
- Breaking existing `refs/heads/hack/tickets` users during migration.

## Portability Contract

### Durable and portable through git

The tickets ref remains the canonical portable payload. It should contain only data that must survive machine changes and offline work:

- the append-only journal
- durable metadata required to interpret the journal
  - storage schema version
  - projection format version
  - migration markers when needed
- durable artifacts that cannot be recreated from the journal alone

For the current implementation, the journal is the existing monthly JSONL event log under `.hack/tickets/events/events-YYYY-MM.jsonl`.

For the normalized model, the journal may move or be segmented differently, but it keeps the same contract:

- append-only
- idempotent merge by stable entry identity
- sufficient to rebuild user-visible ticket history

### Rebuildable local state

Anything that can be deterministically recreated from the durable layer is local state, not portable state. This includes:

- normalized projections
- lookup indexes
- caches
- lock files
- the tickets bare repo and tickets worktree used for sync plumbing

In the current implementation that means:

- `.hack/tickets/git/bare.git` is rebuildable git plumbing
- `.hack/tickets/git/worktree` is rebuildable checkout state
- `.hack/tickets/create.lock` is transient concurrency control

In the normalized model, projection files may exist on disk for startup performance, but they remain disposable. Deleting them must never lose history.

## Journal and Projection Rules

### Canonical source of truth

The journal is the only authoritative history.

Projection state is authoritative for nothing. It exists to accelerate reads and to simplify queries, but every projected record must be traceable to journal entries.

### Rebuild guarantee

A machine with only:

- the git repo
- the tickets ref contents
- the current CLI version

must be able to rebuild ticket state without network access.

That rebuild must recover:

- ticket summaries
- comments
- review notes
- sync checkpoints
- sync conflicts and their resolutions

### Projection invalidation

Projection state must be discarded and rebuilt when any of the following changes:

- journal contents change
- storage schema version changes
- projection format version changes
- repair detects corruption or partial local state

The rebuild path should prefer correctness over incremental cleverness. If validity is uncertain, replay the journal again.

## Hidden-Ref Sync Contract

### Default transport

The default portable ref remains:

- hidden mode: `refs/hack/tickets`
- heads mode fallback: `refs/heads/hack/tickets`

The remote tickets ref continues to carry only the portable tickets payload, not local caches or unrelated repo files.

### Compatibility with existing users

Current behavior should remain the migration baseline:

1. Fetch `refs/hack/tickets` first.
2. If it does not exist, fall back to `refs/heads/hack/tickets`.
3. If legacy branch data is present, merge it into the current local tickets state by journal identity, then normalize.
4. Push back to the ref that matches the checked-out source until repair or explicit config changes move the repo to the hidden ref.

This preserves portability for users who already have:

- hidden refs on the remote
- legacy branch refs on the remote
- local clones that have seen one form but not the other

### Merge semantics

Sync merges journal data, not projections.

That means:

- dedupe by stable journal entry id
- keep deterministic ordering
- rebuild projections after merge

Projections should never be merged line-by-line across machines. Replaying the merged journal is the conflict-resolution mechanism for derived state.

### Offline behavior

Offline writes append to the local journal and update local projections.

When connectivity returns:

- fetch remote journal state
- merge by journal identity
- rebuild projections locally
- push the merged journal to the configured tickets ref

This preserves local-first behavior without requiring a central service or always-on connectivity.

## Ref Contents and Repo Hygiene

The tickets ref should remain narrow and reviewable.

Allowed durable contents:

- journal files
- storage manifests needed to interpret journal files
- non-rebuildable ticket artifacts, if the storage model introduces them

Disallowed contents:

- projection caches
- bare git internals
- transient locks
- unrelated files outside `.hack/tickets`

The existing inspect and repair workflow already points in this direction by detecting non-ticket files and rebuilding a clean tickets-only ref. The normalized model should keep that invariant.

## Migration Guidance

### From current event logs

Existing `.hack/tickets/events/*.jsonl` files remain valid durable journal input during migration.

If the normalized model introduces a different journal layout, migration must:

- preserve the old event history exactly
- write enough metadata to identify the migrated schema
- allow rebuild without needing the pre-migration local projection

### From legacy branch refs

Legacy `refs/heads/hack/tickets` remotes remain supported during migration.

The migration-safe order is:

1. fetch hidden ref
2. fetch legacy ref when present
3. merge journal entries idempotently
4. rebuild projections
5. optionally prune the legacy ref only after the hidden ref contains the same durable history

## Validation

- Clone a repo to a fresh machine, delete all local projection state, and verify ticket state rebuilds from the tickets ref alone.
- Create local-only ticket mutations offline, then reconnect and verify merged journal history is preserved after sync.
- Verify hidden-ref users continue to push and fetch `refs/hack/tickets`.
- Verify legacy branch users still sync successfully before repair.
- Verify repair can rebuild a tickets-only ref without losing journal history.
- Verify no projection-only files are required to render `tickets list` or `tickets show`.

## Decision

The normalized tickets model keeps git portability by treating the journal as the only durable portable layer and projection state as rebuildable local state. Hidden-ref sync continues to transport the durable layer, with legacy branch compatibility preserved until users explicitly repair or reconfigure their repo.
