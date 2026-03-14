# Hack Tickets SQLite Projection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local SQLite projection for Hack Tickets that accelerates reads and sync queries while preserving the git-backed JSONL journal as the only portable source of truth.

**Architecture:** Build a `bun:sqlite` projection database under `.hack/tickets/state`, store a durable replay index keyed by `eventId`, and derive ticket/read tables from the existing journal event stream. Rebuild and incremental replay must use the same code path so crash recovery and deterministic rebuild behavior stay simple.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, existing tickets git channel, Bun tests

---

### Task 1: Lock The Projection Contract In Tests

**Files:**

- Create: `tests/tickets-projection.test.ts`
- Modify: `tests/tickets-store.test.ts`

**Step 1: Write failing projection tests**

- Add a test that rebuilds from a fixed journal and asserts ticket, comment, checkpoint, and conflict rows are present in the projection.
- Add a test that replays the same event stream twice and asserts child rows are not duplicated.
- Add a test that feeds the same `eventId` with different payloads and asserts replay fails with a corruption error.

**Step 2: Run focused tests to verify failure** Run: `bun test tests/tickets-projection.test.ts tests/tickets-store.test.ts` Expected: FAIL because no projection module or corruption checks exist yet.

**Step 3: Commit**

```bash
git add tests/tickets-projection.test.ts tests/tickets-store.test.ts
git commit -m "test(tickets): define projection replay contract"
```

### Task 2: Add SQLite Schema And Projection Metadata

**Files:**

- Create: `src/control-plane/extensions/tickets/projection.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Test: `tests/tickets-projection.test.ts`

**Step 1: Write the minimal schema bootstrap**

- Create schema helpers for:
  - `projection_meta`
  - `journal_events`
  - `journal_segments`
  - `tickets`
  - `ticket_dependencies`
  - `ticket_blocks`
  - `ticket_tags`
  - `ticket_comments`
  - `ticket_review_notes`
  - `ticket_sync_checkpoints`
  - `ticket_sync_conflicts`

**Step 2: Wire projection path resolution**

- Resolve the database path under `.hack/tickets/state/projection.sqlite`.
- Ensure the state directory exists without placing the SQLite file inside the synced tickets worktree.

**Step 3: Run focused tests** Run: `bun test tests/tickets-projection.test.ts` Expected: FAIL only on replay behavior, not missing schema setup.

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/projection.ts src/control-plane/extensions/tickets/store.ts
git commit -m "feat(tickets): add projection schema bootstrap"
```

### Task 3: Implement Deterministic Replay And Idempotent Apply

**Files:**

- Modify: `src/control-plane/extensions/tickets/projection.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Test: `tests/tickets-projection.test.ts`

**Step 1: Write the replay engine**

- Detect new or changed journal segments by fingerprint, then rescan those segments fully.
- Parse candidate events in canonical order by `ts`, `orderKey`, `eventId`.
- Insert each event into `journal_events` before mutating read tables.
- Compare payload hashes on duplicate `eventId`.
- Advance `journal_segments` only after the segment scan succeeds.

**Step 2: Implement event appliers**

- `ticket.created`
- `ticket.updated`
- `ticket.status_changed`
- `ticket.comment_appended`
- `ticket.comment_linked`
- `ticket.review_note_appended`
- `ticket.sync_checkpoint_recorded`
- `ticket.sync_conflict_recorded`
- `ticket.sync_conflict_resolved`

**Step 3: Run focused tests** Run: `bun test tests/tickets-projection.test.ts` Expected: PASS

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/projection.ts src/control-plane/extensions/tickets/store.ts tests/tickets-projection.test.ts
git commit -m "feat(tickets): replay journal into sqlite projection"
```

### Task 4: Route Reads Through The Projection With Journal Fallback

**Files:**

- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Change store read paths**

- `listTickets`
- `getTicket`
- `listEvents`
- `getTicketDetail`
- any sync lookup helpers added during implementation

These reads should prefer SQLite and only trigger replay or rebuild when projection state is missing or stale.

**Step 2: Preserve write path semantics**

- Keep event append writing to JSONL through the existing git channel.
- After append success, replay only the new events into SQLite instead of reparsing the entire journal.

**Step 3: Run focused tests** Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts` Expected: PASS

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts
git commit -m "feat(tickets): serve reads from sqlite projection"
```

### Task 5: Add Rebuild And Health Recovery Paths

**Files:**

- Modify: `src/control-plane/extensions/tickets/projection.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Test: `tests/tickets-projection.test.ts`

**Step 1: Add rebuild triggers**

- missing database
- schema version mismatch
- `projection_status = rebuilding`
- SQLite open failure or corruption

**Step 2: Add an explicit rebuild entry point**

- internal store method first
- optional CLI surface only if needed for debugging, for example `hack tickets rebuild`

**Step 3: Run focused tests** Run: `bun test tests/tickets-projection.test.ts tests/tickets-store.test.ts` Expected: PASS

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/projection.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts tests/tickets-projection.test.ts tests/tickets-store.test.ts
git commit -m "feat(tickets): add projection rebuild recovery"
```

### Task 6: Verify Git Sync Interop And Repeated Application

**Files:**

- Modify: `tests/tickets-git-channel.test.ts`
- Modify: `tests/tickets-extension.test.ts`

**Step 1: Add integration coverage**

- sync remote journal content into a local clone
- replay merged logs with duplicate events
- replay a merged monthly segment that introduces older events than the current replay cursor
- confirm projection rows remain correct after repeated sync

**Step 2: Run focused tests** Run: `bun test tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts` Expected: PASS

**Step 3: Commit**

```bash
git add tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts
git commit -m "test(tickets): verify projection sync idempotency"
```

### Task 7: Run Quality Gates And Final Documentation Pass

**Files:**

- Modify: `docs/guides/tickets.md`
- Modify: `docs/plans/2026-03-14-hack-tickets-sqlite-journal-design.md` if implementation changed details
- Modify: `docs/plans/2026-03-14-hack-tickets-sqlite-journal-plan.md` if execution changed steps

**Step 1: Document the new local state layout**

- Describe the projection database as local-only and rebuildable.
- Document any new CLI rebuild or inspect command if added.

**Step 2: Run repo quality gates** Run:

```bash
bun test tests/tickets-projection.test.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts
bun run check
```

Expected: PASS

**Step 3: Commit**

```bash
git add docs/guides/tickets.md docs/plans/2026-03-14-hack-tickets-sqlite-journal-design.md docs/plans/2026-03-14-hack-tickets-sqlite-journal-plan.md tests/tickets-projection.test.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts src/control-plane/extensions/tickets/projection.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts
git commit -m "feat(tickets): finish sqlite projection architecture"
```
