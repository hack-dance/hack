# Tickets Normalization Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Program Scope

This plan is the implementation handoff for `HACK-431`, not an instruction to land the entire normalization effort in one branch. The branch-level deliverable for the program ticket is:

- land this plan and the paired design doc in the repo
- create and link the child tickets in Hack Tickets
- identify the execution order so the normalization work can proceed incrementally

**Goal:** Define and implement a journal-first normalized ticket model with a durable SQLite projection, explicit provenance semantics, idempotent sync behavior, and markdown-backed ticket documents.

**Architecture:** Keep `.hack/tickets/events/*.jsonl` and hidden-ref sync as the canonical portable record. Introduce normalized ticket/provenance/document domain types and a rebuildable SQLite projection under `.hack/tickets/`, then migrate current read paths and sync logic onto that model behind compatibility adapters.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, current tickets extension modules in `src/control-plane/extensions/tickets/`, current Linear sync code in `src/control-plane/extensions/linear/commands.ts`, Bun tests.

---

## Child Ticket Mapping

- `T-00001`: Implement normalized tickets storage and SQLite projection
- `T-00002`: Implement normalized ticket provenance and field authority model
- `T-00003`: Implement idempotent ticket sync and explicit conflict semantics
- `T-00004`: Implement markdown-backed ticket documents and spec support

Recommended execution order:

- `T-00001`
- `T-00002`
- `T-00003` and `T-00004` in parallel after the first two land

Program closeout checklist:

- design doc committed
- implementation plan committed
- `T-00001` through `T-00004` created with dependency edges
- next execution step set to `T-00001`

---

### Task 1: Define the normalized tickets domain module

**Files:**

- Create: `src/control-plane/extensions/tickets/domain.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/util.ts`
- Test: `tests/tickets-store.test.ts`

**Step 1: Write the failing test**

Add assertions in `tests/tickets-store.test.ts` for a normalized domain adapter that can represent:

- stable ticket identity
- provenance metadata
- typed ticket documents
- explicit authority/conflict state

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-store.test.ts` Expected: FAIL because the normalized domain module and adapter do not exist yet.

**Step 3: Write minimal implementation**

Create `src/control-plane/extensions/tickets/domain.ts` with:

- journal envelope types
- normalized ticket types
- provenance types
- document types
- compatibility helpers that map the new normalized model to current `TicketSummary`

Keep `store.ts` using current public return shapes while routing internal state through the new types.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-store.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/domain.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/util.ts tests/tickets-store.test.ts
git commit -m "feat: define normalized tickets domain model"
```

### Task 2: Add journal envelope versioning and deterministic replay ids

**Files:**

- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- Modify: `src/control-plane/extensions/tickets/util.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/tickets-git-channel.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- every written event carries schema version and stable replay identity
- replaying duplicate external events is ignored
- log normalization preserves the new envelope fields

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-store.test.ts tests/tickets-git-channel.test.ts` Expected: FAIL because existing event writes do not include the full normalized envelope.

**Step 3: Write minimal implementation**

Update event creation helpers so every journal event records:

- `eventId`
- `schemaVersion`
- `occurredAt`
- `recordedAt`
- `sourceSystem`
- `sourceOperation`
- `idempotencyKey`
- `causationId`
- `correlationId`

Keep backward-compatible replay support for legacy events during migration.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-store.test.ts tests/tickets-git-channel.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/tickets-git-channel.ts src/control-plane/extensions/tickets/util.ts tests/tickets-store.test.ts tests/tickets-git-channel.test.ts
git commit -m "feat: version ticket journal envelopes"
```

### Task 3: Implement the SQLite projection

**Files:**

- Create: `src/control-plane/extensions/tickets/sqlite-projection.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/extension.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- the projection database is created under `.hack/tickets/`
- reads come back after process restart without replaying the full reducer in memory
- deleting the SQLite file triggers a rebuild from journal files

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts` Expected: FAIL because there is no SQLite projection layer yet.

**Step 3: Write minimal implementation**

Create `src/control-plane/extensions/tickets/sqlite-projection.ts` using `bun:sqlite` with:

- projection metadata table
- journal event bookkeeping
- tickets table
- activity tables for comments, review notes, checkpoints, and conflicts

Update `store.ts` so writes still append to journal first, then project into SQLite.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/sqlite-projection.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/extension.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts
git commit -m "feat: add tickets sqlite projection"
```

### Task 4: Normalize provenance and remote identity

**Files:**

- Create: `src/control-plane/extensions/tickets/provenance.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**

Add tests that require:

- one ticket to link to one or more remote provider objects
- per-field authority to be explicit
- sync conflict creation to cite the last known local and remote field versions

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-store.test.ts tests/linear-commands.test.ts` Expected: FAIL because provenance is still inferred from ad hoc fields.

**Step 3: Write minimal implementation**

Create `src/control-plane/extensions/tickets/provenance.ts` with:

- remote link types
- authority enums
- field version records
- helpers for mapping current `external*` values into the normalized provenance model

Update Linear sync code to read and write through the new provenance layer instead of relying only on top-level `external*` fields.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-store.test.ts tests/linear-commands.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/provenance.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/linear/commands.ts tests/tickets-store.test.ts tests/linear-commands.test.ts
git commit -m "feat: normalize ticket provenance"
```

### Task 5: Add typed markdown-backed ticket documents

**Files:**

- Create: `src/control-plane/extensions/tickets/documents.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Modify: `src/tui/tickets-tui.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- a ticket can have a `description` document and a `spec` document
- the current `body` field remains available as the compatibility projection of the active description document
- document updates append immutable document events instead of mutating prior content

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts` Expected: FAIL because ticket documents are still just a mutable `body` field.

**Step 3: Write minimal implementation**

Create `src/control-plane/extensions/tickets/documents.ts` with:

- document kind enum
- immutable document snapshot types
- compatibility helpers for `body`

Update commands and TUI reads so they can show the active description now and later expose additional document kinds safely.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/documents.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts src/tui/tickets-tui.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts
git commit -m "feat: add markdown-backed ticket documents"
```

### Task 6: Make external sync idempotent against the normalized model

**Files:**

- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/provenance.ts`
- Test: `tests/linear-commands.test.ts`
- Test: `tests/tickets-store.test.ts`

**Step 1: Write the failing test**

Add tests for:

- duplicate webhook or poll deliveries
- repeated outbound checkpoint updates
- review-required conflicts when authority cannot resolve a field automatically

**Step 2: Run test to verify it fails**

Run: `bun test tests/linear-commands.test.ts tests/tickets-store.test.ts` Expected: FAIL because idempotency and authority are not fully normalized yet.

**Step 3: Write minimal implementation**

Update Linear sync handlers so remote operations derive deterministic idempotency keys and only append journal events when the remote mutation is genuinely new. Persist checkpoint and conflict semantics against the provenance model.

**Step 4: Run test to verify it passes**

Run: `bun test tests/linear-commands.test.ts tests/tickets-store.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/provenance.ts tests/linear-commands.test.ts tests/tickets-store.test.ts
git commit -m "feat: make ticket sync idempotent"
```

### Task 7: Validate hidden-ref portability and rebuild behavior end to end

**Files:**

- Modify: `tests/tickets-git-channel.test.ts`
- Modify: `tests/tickets-extension.test.ts`
- Modify: `docs/guides/tickets.md`

**Step 1: Write the failing test**

Add coverage that proves:

- the hidden-ref sync moves journal files only
- peers rebuild local projection state after sync
- deleting local SQLite state does not affect synced ticket history

**Step 2: Run test to verify it fails**

Run: `bun test tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts` Expected: FAIL until projection rebuild and docs are aligned.

**Step 3: Write minimal implementation**

Adjust tests and docs so the portability contract is explicit: JSONL journal is portable, SQLite is local and rebuildable, and read paths repair projection state automatically.

**Step 4: Run test to verify it passes**

Run: `bun test tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts docs/guides/tickets.md
git commit -m "docs: clarify normalized tickets portability"
```

### Task 8: Full verification

**Files:**

- Verify all touched tickets and Linear files
- Modify: docs if verification reveals contract drift

**Step 1: Run verification gates**

Run:

```bash
bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts tests/linear-commands.test.ts
bun run check
```

Expected: PASS

**Step 2: Perform manual sanity checks**

Verify:

- `hack tickets create/list/show/update/status` still work
- journal files remain under `.hack/tickets/events/`
- projection rebuild happens when the SQLite file is removed
- remote sync behavior remains idempotent for repeated inbound changes
- description/spec documents render correctly through the current CLI compatibility path

**Step 3: Commit final integrated changes**

```bash
git add src/control-plane/extensions/tickets/domain.ts src/control-plane/extensions/tickets/sqlite-projection.ts src/control-plane/extensions/tickets/provenance.ts src/control-plane/extensions/tickets/documents.ts src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/tickets-git-channel.ts src/control-plane/extensions/tickets/commands.ts src/control-plane/extensions/tickets/util.ts src/control-plane/extensions/tickets/extension.ts src/control-plane/extensions/linear/commands.ts src/tui/tickets-tui.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts tests/linear-commands.test.ts docs/guides/tickets.md
git commit -m "feat: normalize tickets storage and sync"
```

Plan complete and saved to `docs/plans/2026-03-13-tickets-normalization-core-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
