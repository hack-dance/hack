# Runtime Crash Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve runtime/proxy recovery by adding explicit operator guidance in `hack doctor` and richer, self-explanatory artifacts in `hack crash-capture`.

**Architecture:** Keep the existing diagnostics commands, but add shared recovery diagnosis helpers that classify failures into restart, repair, and follow-up buckets. Use those helpers to render a recovery panel in `hack doctor` and to write `summary.json` and `README.txt` inside crash bundles.

**Tech Stack:** Bun, TypeScript, Bun test, existing CLI display helpers

---

### Task 1: Add failing tests for doctor recovery guidance

**Files:**
- Create: `tests/doctor-command.test.ts`
- Modify: `src/commands/doctor.ts`

**Step 1: Write the failing test**

Add focused tests for recovery diagnosis such as:
- proxy/global runtime down suggests `hack global up`
- stale host mapping suggests `hack restart`
- DNS/network drift suggests `hack doctor --fix`
- stale daemon state suggests the daemon restart path

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/doctor-command.test.ts
```

Expected: FAIL because the exported diagnosis helpers do not exist yet.

**Step 3: Write minimal implementation**

Export the smallest helper surface needed to classify check results and render ordered recovery actions.

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/doctor-command.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/doctor-command.test.ts
git commit -m "test: cover doctor recovery guidance"
```

### Task 2: Add failing tests for crash bundle summaries

**Files:**
- Create: `tests/crash-capture.test.ts`
- Modify: `src/commands/crash-capture.ts`

**Step 1: Write the failing test**

Add tests for:
- summary generation from command results
- readable README content
- recovery recommendations matching doctor heuristics
- process snapshot command not depending on `rg`

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/crash-capture.test.ts
```

Expected: FAIL because the new helpers and artifacts do not exist yet.

**Step 3: Write minimal implementation**

Export bundle-summary helpers and update the capture command list/artifact writers.

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/crash-capture.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/crash-capture.ts tests/crash-capture.test.ts
git commit -m "test: cover crash bundle summaries"
```

### Task 3: Implement the doctor recovery panel

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/doctor-command.test.ts`

**Step 1: Write the failing test**

Extend the tests to assert grouped recovery actions and the temporary-vs-configuration distinction.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/doctor-command.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

- classify checks into recovery buckets
- render a single panel with ordered commands
- keep unknown issues explicit rather than guessing

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/doctor-command.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/doctor-command.test.ts
git commit -m "feat: add explicit doctor recovery guidance"
```

### Task 4: Implement richer crash bundle artifacts

**Files:**
- Modify: `src/commands/crash-capture.ts`
- Test: `tests/crash-capture.test.ts`

**Step 1: Write the failing test**

Extend the tests to assert:
- `summary.json` structure
- `README.txt` guidance text
- additional capture commands included

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/crash-capture.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

- capture additional doctor/global/runtime diagnostics
- write bundle summary/readme artifacts
- switch the process snapshot command to a portable filter

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/crash-capture.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/crash-capture.ts tests/crash-capture.test.ts
git commit -m "feat: improve crash capture triage artifacts"
```

### Task 5: Update docs and verify quality gates

**Files:**
- Modify: `README.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing test**

No automated test. Use doc consistency review against the implementation.

**Step 2: Run verification**

Run:
```bash
bun test tests/doctor-command.test.ts tests/crash-capture.test.ts
bun test
bun x ultracite fix
bun x ultracite check
```

Expected: targeted tests pass; full suite and checks pass or expose any unrelated failures that must be reported.

**Step 3: Write minimal implementation**

Update docs to mirror the same recovery sequence shown by `hack doctor`.

**Step 4: Commit**

```bash
git add README.md docs/cli.md
git commit -m "docs: document runtime and proxy recovery workflow"
```
