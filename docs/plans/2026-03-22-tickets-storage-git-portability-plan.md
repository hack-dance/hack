# Tickets Storage Git Portability Implementation Plan

**Goal:** Preserve git portability and hidden-ref sync while moving tickets to a normalized journal-plus-projection storage model.

**Architecture:** Keep the tickets ref as the durable transport layer, keep the journal as the canonical source of truth, rebuild projections locally, and preserve the current hidden-ref plus legacy-branch migration behavior in `tickets-git-channel.ts`.

**Tech Stack:** Bun, TypeScript, tickets control-plane store, tickets git channel, Bun tests.

---

### Task 1: Introduce an explicit durable-vs-derived storage contract in code

**Files:**
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- Add or modify: storage manifest helpers under `src/control-plane/extensions/tickets/`
- Test: `tests/tickets-store.test.ts`

**Step 1: Define the portable payload**

Encode a small storage contract in code so the implementation can distinguish:

- durable journal data that belongs in git
- durable metadata needed to interpret the journal
- derived local projection state that can be rebuilt

This should be explicit enough that future storage changes cannot accidentally make projection files authoritative.

**Step 2: Add a versioned manifest if the normalized model needs one**

If the new storage layout introduces journal manifests or storage metadata, keep them inside the tickets ref and version them clearly.

**Step 3: Keep rebuildability as the invariant**

The store should continue to support rebuilding ticket state by replaying durable journal data, even if projection files are added for read performance.

**Step 4: Add focused tests**

Verify that deleting derived state does not lose ticket history and that the store can rebuild from the durable journal payload alone.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/tickets-git-channel.ts tests/tickets-store.test.ts
git commit -m "feat(tickets): encode portable storage contract"
```

### Task 2: Keep the tickets ref limited to portable state

**Files:**
- Modify: `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- Test: `tests/tickets-git-channel.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Define which paths are allowed in the tickets ref**

The ref should contain only:

- journal files
- durable storage metadata
- any non-rebuildable ticket artifacts introduced by the normalized model

It should not contain:

- projection caches
- bare git internals
- local lock files
- unrelated repository content

**Step 2: Preserve repair behavior**

Keep `inspect` and `repair` aligned with that invariant so a dirty or legacy tickets ref can be rebuilt into a tickets-only portable payload.

**Step 3: Add tests for path hygiene**

Verify the ref remains limited to durable ticket payload and that repair removes non-ticket state without losing history.

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/tickets-git-channel.ts tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts
git commit -m "test(tickets): enforce tickets ref portability rules"
```

### Task 3: Preserve hidden-ref and legacy-branch sync behavior during migration

**Files:**
- Modify: `src/control-plane/extensions/tickets/tickets-git-channel.ts`
- Test: `tests/tickets-git-channel.test.ts`
- Test: `tests/tickets-extension.test.ts`

**Step 1: Keep hidden refs as the default**

Maintain the current default transport:

- hidden mode: `refs/hack/tickets`
- heads mode fallback: `refs/heads/hack/tickets`

**Step 2: Keep migration-safe fetch and push rules**

The migration path should continue to:

1. fetch the hidden ref first
2. fall back to the legacy branch ref when the hidden ref is missing
3. merge journal entries idempotently
4. rebuild projections after merge
5. only prune the legacy ref after the hidden ref carries equivalent durable history

**Step 3: Test offline and mixed-history cases**

Add or update tests for:

- hidden-ref only remotes
- legacy branch only remotes
- remotes with both refs present
- local offline writes followed by sync

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/tickets-git-channel.ts tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts
git commit -m "feat(tickets): preserve hidden ref migration semantics"
```

### Task 4: Make projection rebuild behavior explicit and disposable

**Files:**
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Add or modify: projection rebuild helpers under `src/control-plane/extensions/tickets/`
- Test: `tests/tickets-store.test.ts`

**Step 1: Treat projections as cache, not source of truth**

If the normalized storage model adds materialized views or indexes, make the rebuild triggers explicit:

- journal contents changed
- storage version changed
- projection version changed
- local state is corrupt or incomplete

**Step 2: Prefer replay over partial trust**

When validity is uncertain, rebuild from the durable journal rather than attempting risky incremental repair of derived state.

**Step 3: Add rebuild-path tests**

Verify projection invalidation and rebuild do not lose comments, review notes, checkpoints, or conflicts.

**Step 4: Commit**

```bash
git add src/control-plane/extensions/tickets/store.ts tests/tickets-store.test.ts
git commit -m "feat(tickets): rebuild projections from durable journal"
```

### Task 5: Update user-facing docs to match the shipped model

**Files:**
- Modify: `docs/guides/tickets.md`
- Modify: `docs/plans/2026-03-22-tickets-storage-git-portability-design.md`
- Modify: migration notes if implementation details diverge

**Step 1: Document the final storage layout**

Keep the guide accurate about:

- what is durable
- what is rebuildable
- how hidden-ref sync behaves
- how legacy refs are migrated

**Step 2: Remove any stale wording from pre-normalization docs**

Do not leave docs implying that derived local state must be preserved or committed.

**Step 3: Commit**

```bash
git add docs/guides/tickets.md docs/plans/2026-03-22-tickets-storage-git-portability-design.md
git commit -m "docs(tickets): update normalized storage guidance"
```

### Task 6: Full verification

**Files:**
- Verify touched tickets code and docs

**Step 1: Run targeted tests**

Run:

```bash
bun test tests/tickets-store.test.ts tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts
```

Expected: PASS

**Step 2: Run broader workspace checks if shared behavior changed**

Run:

```bash
bun run typecheck
bun run test
bun run check
```

Expected: PASS

**Step 3: Perform a git portability smoke check**

Verify manually or with an integration test:

- clone to a fresh repo
- recreate local derived state from the tickets ref
- confirm hidden-ref sync still works
- confirm legacy-branch fallback still works

**Step 4: Commit final integrated changes**

```bash
git add src/control-plane/extensions/tickets docs/guides/tickets.md docs/plans/2026-03-22-tickets-storage-git-portability-design.md docs/plans/2026-03-22-tickets-storage-git-portability-plan.md tests/tickets-store.test.ts tests/tickets-git-channel.test.ts tests/tickets-extension.test.ts
git commit -m "Finish tickets storage portability migration"
```
