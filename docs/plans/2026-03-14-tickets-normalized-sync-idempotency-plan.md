# Tickets Normalized Sync Idempotency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement deterministic external sync identity, explicit checkpoint-based conflict handling, and idempotent conflict resolution for normalized ticket sync.

**Architecture:** Extend the tickets store so external sync writers can supply stable operation-derived ids and metadata, then move the Linear adapter onto that contract. Keep transport-level merge dedupe by `eventId`, but make external sync events and conflicts deterministic so multi-machine replay converges without duplicate checkpoints or silent overwrites.

**Tech Stack:** Bun, TypeScript, git-backed tickets event log, Linear sync adapter tests, Bun test

---

### Task 1: Add deterministic sync event metadata to the tickets store

**Files:**

- Modify: `src/control-plane/extensions/tickets/store.ts`
- Test: `tests/tickets-store.test.ts`

**Step 1: Write the failing store test**

Add a store-level test next to `tickets store materializes assignee, review notes, comments, checkpoints, and conflicts` that records the same logical checkpoint twice with stable metadata and expects one logical result after materialization.

```ts
test("recordSyncCheckpoint reuses deterministic ids for the same external operation", async () => {
  const checkpointA = await store.recordSyncCheckpoint({
    ticketId,
    provider: "linear",
    profileId: "default",
    operationKey: "linear:default:issue:ENG-123:update:v5:title",
    checkpointId: "checkpoint-linear-eng-123-v5-title",
    eventId: "event-linear-eng-123-v5-title-checkpoint",
    externalEntityId: "issue-1",
    externalVersion: "v5",
    baselineCheckpointId: "checkpoint-linear-eng-123-v4-title",
    direction: "linear_to_hack",
    remoteCursor: "ENG-123"
  })

  const checkpointB = await store.recordSyncCheckpoint({
    ticketId,
    provider: "linear",
    profileId: "default",
    operationKey: "linear:default:issue:ENG-123:update:v5:title",
    checkpointId: "checkpoint-linear-eng-123-v5-title",
    eventId: "event-linear-eng-123-v5-title-checkpoint",
    externalEntityId: "issue-1",
    externalVersion: "v5",
    baselineCheckpointId: "checkpoint-linear-eng-123-v4-title",
    direction: "linear_to_hack",
    remoteCursor: "ENG-123"
  })

  expect(checkpointA.ok).toBe(true)
  expect(checkpointB.ok).toBe(true)
})
```

**Step 2: Run the focused store test to verify it fails**

Run: `bun test tests/tickets-store.test.ts`

Expected: a type or assertion failure because `recordSyncCheckpoint` does not yet accept stable ids or persist normalized sync metadata.

**Step 3: Implement deterministic checkpoint/conflict metadata plumbing**

Update `TicketSyncCheckpoint`, `TicketSyncConflict`, and the write helpers in `store.ts` so external sync calls can pass stable ids and metadata instead of always generating random ids.

```ts
type TicketSyncCheckpoint = {
  readonly checkpointId: string
  readonly ticketId: string
  readonly provider: string
  readonly profileId?: string
  readonly operationKey?: string
  readonly externalEntityId?: string
  readonly externalVersion?: string
  readonly baselineCheckpointId?: string
  readonly authority?: string
  readonly origin?: string
  readonly direction?: string
  readonly remoteCursor?: string
  readonly remoteUpdatedAt?: string
  readonly localUpdatedAt?: string
  readonly actor: string
  readonly createdAt: string
}

type TicketEventInput = {
  readonly ticketId: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly eventId?: string
}
```

Use the caller-provided `eventId` when present, and fall back to `randomUUID()` only for local-only ticket events.

**Step 4: Extend sync conflict writes and fold materialization**

Teach `recordSyncConflict`, `resolveSyncConflict`, `applyTicketSyncCheckpointRecordedEvent`, `applyTicketSyncConflictRecordedEvent`, and `applyTicketSyncConflictResolvedEvent` to persist and materialize:

- `operationKey`
- `conflictKey`
- `externalEntityId`
- `externalVersion`
- `baselineCheckpointId`
- `authority`
- `origin`

Use stable ids from the caller when provided, and keep fallback generation for older local call sites.

**Step 5: Run the store test suite again**

Run: `bun test tests/tickets-store.test.ts`

Expected: the new deterministic-id test passes and existing sync metadata tests still pass.

**Step 6: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts tests/tickets-store.test.ts
git commit -m "feat(tickets): add deterministic sync event metadata"
```

### Task 2: Make sync conflicts and resolutions idempotent in the store

**Files:**

- Modify: `src/control-plane/extensions/tickets/store.ts`
- Test: `tests/tickets-store.test.ts`

**Step 1: Write failing tests for duplicate conflict and duplicate resolution replay**

Add tests that record the same `conflictKey` twice and resolve the same conflict twice with the same deterministic resolution event id.

```ts
test("recordSyncConflict collapses repeated conflictKey replays", async () => {
  const first = await store.recordSyncConflict({
    ticketId,
    provider: "linear",
    field: "title",
    conflictKey: 'linear|T-00001|title|checkpoint-4|"Local"|"Remote"',
    conflictId: "conflict-linear-title-checkpoint-4",
    eventId: "event-linear-title-checkpoint-4-conflict",
    baselineCheckpointId: "checkpoint-4",
    operationKey: "linear:default:issue:ENG-123:update:v5:title",
    localValue: "Local",
    remoteValue: "Remote"
  })

  const second = await store.recordSyncConflict({
    ticketId,
    provider: "linear",
    field: "title",
    conflictKey: 'linear|T-00001|title|checkpoint-4|"Local"|"Remote"',
    conflictId: "conflict-linear-title-checkpoint-4",
    eventId: "event-linear-title-checkpoint-4-conflict",
    baselineCheckpointId: "checkpoint-4",
    operationKey: "linear:default:issue:ENG-123:update:v5:title",
    localValue: "Local",
    remoteValue: "Remote"
  })

  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
})
```

**Step 2: Run the focused store tests to verify they fail**

Run: `bun test tests/tickets-store.test.ts`

Expected: duplicate conflict and duplicate resolution replay still produce duplicate materialized records or duplicate events.

**Step 3: Implement idempotent conflict and resolution behavior**

Change `recordSyncConflict` and `resolveSyncConflict` so they can no-op when the same deterministic event or the same open conflict already exists.

```ts
const existingOpenConflict = conflicts.find(
  conflict => conflict.status === "open" && conflict.conflictKey === input.conflictKey
)

if (existingOpenConflict) {
  return { ok: true, conflict: existingOpenConflict }
}
```

For resolutions:

- return success when the same conflict already has the same resolution
- reject or ignore only when the replay attempts a different resolution for the same already-resolved conflict

**Step 4: Preserve compatibility for old events**

Keep the fold tolerant of older events that do not have `operationKey`, `conflictKey`, or `baselineCheckpointId`, but prefer the explicit keys when they exist.

**Step 5: Run the store tests again**

Run: `bun test tests/tickets-store.test.ts`

Expected: the new idempotency tests pass along with the existing store coverage.

**Step 6: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts tests/tickets-store.test.ts
git commit -m "feat(tickets): make sync conflicts idempotent"
```

### Task 3: Move the Linear adapter onto checkpoint-based conflict decisions

**Files:**

- Modify: `src/control-plane/extensions/linear/commands.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write failing Linear adapter tests**

Add tests near `detectAuthoritativeFieldConflicts reports divergence for hack-owned tickets` and the sync direction tests that cover:

- repeated application of the same remote change derives the same ids
- two-sided divergence uses the last checkpoint baseline instead of raw current-vs-remote comparison
- repeated sync of the same conflict only records one conflict

```ts
test("recordAuthoritativeConflicts reuses conflictKey for repeated Linear divergence", async () => {
  const recorded = await __testOnly.recordAuthoritativeConflicts({
    tickets,
    ticketId: "T-00001",
    conflicts: [
      {
        field: "title",
        authority: "shared_manual",
        operationKey: "linear:default:issue:ENG-123:update:v5:title",
        conflictKey: 'linear|T-00001|title|checkpoint-4|"Local"|"Remote"',
        baselineCheckpointId: "checkpoint-4",
        localValue: "Local",
        remoteValue: "Remote"
      }
    ]
  })

  expect(recorded.ok).toBe(true)
  expect(recorded.recorded).toBe(1)
})
```

**Step 2: Run the Linear test file to verify it fails**

Run: `bun test tests/linear-commands.test.ts`

Expected: the adapter tests fail because Linear sync still uses ad hoc field/value dedupe and does not derive deterministic operation metadata.

**Step 3: Add normalized sync helpers in `linear/commands.ts`**

Introduce small helpers for:

- deriving `operationKey`
- deriving deterministic checkpoint event ids
- deriving deterministic `conflictKey`
- reading the last relevant baseline checkpoint for a ticket/profile/field

```ts
function buildLinearOperationKey(input: {
  readonly profileId: string
  readonly issue: LinearIssue
  readonly mutationKind: "linear_to_hack" | "hack_to_linear"
  readonly field: string
}): string {
  return [
    "linear",
    input.profileId,
    "issue",
    input.issue.id,
    input.mutationKind,
    input.issue.updatedAt ?? input.issue.identifier,
    input.field
  ].join(":")
}
```

Use these helpers inside `recordAuthoritativeConflicts`, `recordLinearSyncCheckpoint`, `syncTicketToLinearIssue`, `upsertTicketFromLinearIssue`, `applyLinearIssueToExistingTicket`, and `createTicketFromLinearIssueProjection`.

**Step 4: Replace ad hoc conflict dedupe with normalized keys**

Remove reliance on `buildConflictDedupKey` as the system contract. Instead:

- compare against the last checkpoint baseline when deciding whether a change is remote-only, local-only, same-value, or divergent
- pass `operationKey`, `conflictKey`, `baselineCheckpointId`, and deterministic ids into the tickets store

Keep the current field scope conservative for this pass: `title`, `body`, `status`, and `project`.

**Step 5: Re-run the Linear test file**

Run: `bun test tests/linear-commands.test.ts`

Expected: the new replay/baseline tests pass and the existing Linear sync tests still pass.

**Step 6: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts tests/linear-commands.test.ts
git commit -m "feat(linear): use normalized sync ids and baselines"
```

### Task 4: Expose the new sync metadata in ticket inspection surfaces

**Files:**

- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Write the failing surface tests**

Extend the existing `tickets show json includes materialized sync metadata` coverage so the JSON payload includes the new metadata, and add a CLI assertion that the text table shows enough information to explain a checkpoint or conflict.

```ts
expect(payload.syncCheckpoints[0]).toMatchObject({
  provider: "linear",
  operationKey: "linear:default:issue:ENG-123:update:v5:title",
  externalVersion: "v5",
  baselineCheckpointId: "checkpoint-linear-eng-123-v4-title"
})

expect(payload.conflicts[0]).toMatchObject({
  field: "title",
  conflictKey: 'linear|T-00001|title|checkpoint-4|"Local"|"Remote"',
  authority: "shared_manual"
})
```

**Step 2: Run the tickets command tests to verify they fail**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts`

Expected: the payload and CLI output do not yet expose the new metadata fields.

**Step 3: Update the JSON and text surfaces**

In `tickets/commands.ts`, extend the checkpoint and conflict tables so operators can see:

- `operationKey`
- `baselineCheckpointId`
- `externalVersion`
- `conflictKey`
- `authority`

Keep the JSON surface exhaustive and the text surface concise.

**Step 4: Re-run the tickets command tests**

Run: `bun test tests/tickets-store.test.ts tests/tickets-extension.test.ts`

Expected: JSON output includes the new metadata and the CLI still renders correctly.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/commands.ts src/control-plane/extensions/tickets/store.ts tests/tickets-store.test.ts tests/tickets-extension.test.ts
git commit -m "feat(tickets): expose normalized sync metadata"
```

### Task 5: Prove convergence with merge-level replay tests and run the focused validation suite

**Files:**

- Modify: `tests/tickets-git-channel.test.ts`
- Test: `tests/tickets-store.test.ts`
- Test: `tests/linear-commands.test.ts`
- Test: `tests/tickets-extension.test.ts`
- Test: `tests/tickets-git-channel.test.ts`

**Step 1: Write the replay/convergence test**

Add a merge-level test that simulates two machines appending the same deterministic external sync event ids and verifies that merged logs collapse to one logical operation.

```ts
test("mergeTicketEventLogs collapses repeated deterministic external sync events", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-linear-eng-123-v5-title-checkpoint",
        ts: 10,
        ticketId: "T-00001",
        type: "ticket.sync_checkpoint_recorded"
      }),
      ""
    ].join("\\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-linear-eng-123-v5-title-checkpoint",
        ts: 10,
        ticketId: "T-00001",
        type: "ticket.sync_checkpoint_recorded"
      }),
      ""
    ].join("\\n")
  })

  expect(merged.trim().split("\\n")).toHaveLength(1)
})
```

**Step 2: Run the focused validation suite**

Run:

- `bun test tests/tickets-store.test.ts`
- `bun test tests/linear-commands.test.ts`
- `bun test tests/tickets-extension.test.ts`
- `bun test tests/tickets-git-channel.test.ts`

Expected: all focused sync and tickets tests pass.

**Step 3: Run the repo-level quality gates for the touched area**

Run:

- `bun run test`
- `bun run typecheck`
- `bun run check`

Expected: workspace tests, typechecking, and checks pass after the focused sync changes land.

**Step 4: Commit**

```bash
git add tests/tickets-git-channel.test.ts
git commit -m "test(tickets): cover normalized sync replay convergence"
```

### Task 6: Final review and handoff

**Files:**

- Review: `docs/plans/2026-03-14-tickets-normalized-sync-idempotency-design.md`
- Review: `docs/plans/2026-03-14-tickets-normalized-sync-idempotency-plan.md`

**Step 1: Verify the implementation against the design checklist**

Confirm the final code satisfies:

- deterministic `operationKey` and `eventId` reuse
- baseline-aware conflict decisions
- explicit authority handling
- stable `conflictKey` and idempotent conflict resolution
- operator-visible sync metadata

**Step 2: Capture any remaining follow-up**

If the implementation deliberately leaves out broader shared fields like `assignee` or dependency edges, file a follow-up ticket before ending the session.

**Step 3: Prepare the branch for review**

Run:

- `git status --short`
- `git log --oneline -n 10`

Expected: only intentional commits are present and the worktree is clean.
