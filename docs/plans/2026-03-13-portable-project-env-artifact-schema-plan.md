# Portable Project Env Artifact Schema Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a stable portable managed env artifact model that can normalize plaintext and secret values, materialize local compatibility files, and support future remote publish/apply flows without changing the existing contract file format.

**Architecture:** Keep `.hack/hack.env.json` as the committed declaration contract. Introduce a typed managed artifact model for canonical values plus metadata, then add read/write helpers that translate between the artifact and existing local compatibility targets (`.hack/.env` and the configured secret backend).

**Tech Stack:** Bun, TypeScript, existing CLI env commands, Bun test, docs in `docs/env.md` and `docs/plans/`

---

### Task 1: Add managed artifact types and parsing

**Files:**

- Create: `src/lib/managed-env-artifact.ts`
- Test: `tests/managed-env-artifact.test.ts`
- Modify: `src/constants.ts`

**Step 1: Write the failing test**

Add parser/serializer tests that cover:

- valid artifact parse for plaintext entries
- valid artifact parse for secret entries
- service scope parsing with `null` and specific service lists
- stable serialization ordering
- invalid version rejection

**Step 2: Run test to verify it fails**

Run: `bun test tests/managed-env-artifact.test.ts` Expected: FAIL because the module and types do not exist yet.

**Step 3: Write minimal implementation**

Create:

- artifact version constant
- `PortableProjectEnvArtifact`
- `PortableProjectEnvEntry`
- `readManagedEnvArtifact`
- `parseManagedEnvArtifact`
- `serializeManagedEnvArtifact`

Keep the schema narrow:

- top-level metadata
- entries with `key`, `value.kind`, `value.text`, `required`, `services`, `description`

**Step 4: Run test to verify it passes**

Run: `bun test tests/managed-env-artifact.test.ts` Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/managed-env-artifact.ts src/constants.ts tests/managed-env-artifact.test.ts
git commit -m "feat: add managed env artifact schema"
```

### Task 2: Normalize current local env state into the artifact

**Files:**

- Modify: `src/lib/hack-env.ts`
- Test: `tests/managed-env-artifact.test.ts`
- Test: `tests/env-backend-command.test.ts`

**Step 1: Write the failing test**

Add tests that normalize:

- contract + `.hack/.env` into plaintext entries
- contract + secret store into secret entries
- mixed plaintext and secret entries
- contract descriptions and service scope copied into the artifact

**Step 2: Run test to verify it fails**

Run: `bun test tests/managed-env-artifact.test.ts tests/env-backend-command.test.ts` Expected: FAIL because normalization helpers do not exist.

**Step 3: Write minimal implementation**

Add helpers that:

- resolve current local values using existing env logic
- build a canonical artifact entry list
- preserve contract metadata in the artifact
- keep entries sorted by key and services sorted alphabetically

**Step 4: Run test to verify it passes**

Run: `bun test tests/managed-env-artifact.test.ts tests/env-backend-command.test.ts` Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/hack-env.ts tests/managed-env-artifact.test.ts tests/env-backend-command.test.ts
git commit -m "feat: normalize local env state into managed artifacts"
```

### Task 3: Materialize artifact values back into local compatibility files

**Files:**

- Modify: `src/lib/hack-env.ts`
- Modify: `src/lib/secret-store.ts`
- Test: `tests/env-backend-command.test.ts`

**Step 1: Write the failing test**

Add tests that:

- write plaintext artifact entries into `.hack/.env`
- write secret artifact entries into the configured secret backend
- delete old local state when an entry changes kind
- leave unrelated keys untouched

**Step 2: Run test to verify it fails**

Run: `bun test tests/env-backend-command.test.ts` Expected: FAIL because artifact materialization does not exist.

**Step 3: Write minimal implementation**

Add a helper that takes a managed artifact and:

- writes plaintext entries to `.hack/.env`
- writes secret entries to the configured secret store
- removes stale keys from the wrong local target when kind changes

Do not add remote storage in this task.

**Step 4: Run test to verify it passes**

Run: `bun test tests/env-backend-command.test.ts` Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/hack-env.ts src/lib/secret-store.ts tests/env-backend-command.test.ts
git commit -m "feat: materialize managed env artifacts locally"
```

### Task 4: Add CLI visibility for managed artifact state

**Files:**

- Modify: `src/commands/env.ts`
- Test: `tests/env-backend-command.test.ts`

**Step 1: Write the failing test**

Add tests for:

- artifact-aware `hack env list --json`
- drift reporting between artifact and local compatibility state
- explicit reporting of `plaintext` vs `secret` kind

**Step 2: Run test to verify it fails**

Run: `bun test tests/env-backend-command.test.ts` Expected: FAIL because the CLI output does not expose managed artifact state yet.

**Step 3: Write minimal implementation**

Extend `hack env list` output to show:

- managed artifact presence
- value kind
- contract metadata
- local drift state

Keep existing output compatible where possible.

**Step 4: Run test to verify it passes**

Run: `bun test tests/env-backend-command.test.ts` Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/env.ts tests/env-backend-command.test.ts
git commit -m "feat: surface managed env artifact state in env list"
```

### Task 5: Document artifact rules and upgrade path

**Files:**

- Modify: `docs/env.md`
- Modify: `docs/guides/init-project.md`
- Modify: `src/templates.ts`

**Step 1: Write the failing test**

No code test is required for this task. Use doc review plus template output review.

**Step 2: Run verification to confirm the current docs are incomplete**

Run: `grep -n \"managed artifact\\|portable artifact\" docs/env.md docs/guides/init-project.md src/templates.ts` Expected: incomplete or missing references to the new artifact model.

**Step 3: Write minimal implementation**

Document:

- contract vs artifact vs local compatibility split
- opt-in upgrade path
- any template notes needed for future initialization behavior

Do not start scaffolding the artifact by default unless the implementation requires it.

**Step 4: Run verification to confirm docs are updated**

Run: `grep -n \"managed artifact\\|portable artifact\" docs/env.md docs/guides/init-project.md src/templates.ts` Expected: matches in the updated docs.

**Step 5: Commit**

```bash
git add docs/env.md docs/guides/init-project.md src/templates.ts
git commit -m "docs: describe managed env artifact model"
```

## Recommended Execution Order

1. Add the standalone artifact module first.
2. Normalize current local state into the artifact.
3. Add local materialization helpers.
4. Surface the new state in CLI output.
5. Update docs only after the code contract is settled.

## Risks To Watch

- accidental breaking changes to existing `.hack/hack.env.json` parsing
- leaking secret values into `.hack/.env` during kind changes
- making `hack env list --json` incompatible for existing consumers
- treating local compatibility files as canonical instead of derived

## Links

- `docs/plans/2026-03-13-portable-project-env-artifact-schema-design.md`
- `docs/plans/2026-03-06-remote-encrypted-project-env-portability-plan.md`
