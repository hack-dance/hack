# Daemon Runtime Reset Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve daemon runtime reset detection, safe auto-repair, and user-visible repair guidance for stale or incompatible daemon state.

**Architecture:** Extend runtime health with reset-diff metadata, expand daemon status probing beyond a boolean API check, and let the daemon client auto-repair only the stale-state cases that are safe to recover automatically. Keep incompatible live-daemon cases as guided repair.

**Tech Stack:** Bun, TypeScript, Bun test

---

### Task 1: Add failing runtime reset detail tests

**Files:**
- Modify: `tests/runtime-cache.test.ts`
- Modify: `src/daemon/runtime-cache.ts`
- Modify: `src/daemon/runtime-health.ts`

**Step 1: Write the failing test**

Add assertions that a reset caused by engine version or engine name drift records reset reasons and a summary in runtime health payloads.

**Step 2: Run test to verify it fails**

Run: `bun test tests/runtime-cache.test.ts`
Expected: FAIL because reset detail fields are not implemented yet.

**Step 3: Write minimal implementation**

Add runtime identity diff helpers, extend fingerprint coverage, and persist reset reasons/summary in runtime cache health serialization.

**Step 4: Run test to verify it passes**

Run: `bun test tests/runtime-cache.test.ts`
Expected: PASS

### Task 2: Add failing daemon status guidance tests

**Files:**
- Modify: `tests/daemon-status.test.ts`
- Modify: `src/daemon/status.ts`

**Step 1: Write the failing test**

Add a case where the daemon API is reachable but version-incompatible and assert that status reports guided repair with `hack daemon restart`.

**Step 2: Run test to verify it fails**

Run: `bun test tests/daemon-status.test.ts`
Expected: FAIL because incompatible daemon state is not classified today.

**Step 3: Write minimal implementation**

Extend status reporting with daemon probe metadata, issue classification, and next-step guidance.

**Step 4: Run test to verify it passes**

Run: `bun test tests/daemon-status.test.ts`
Expected: PASS

### Task 3: Add failing daemon client auto-repair tests

**Files:**
- Create: `tests/daemon-client.test.ts`
- Modify: `src/daemon/client.ts`

**Step 1: Write the failing test**

Add coverage for `requestDaemonJson()` automatically restarting when stale socket/pid state is detected, then retrying the request successfully.

**Step 2: Run test to verify it fails**

Run: `bun test tests/daemon-client.test.ts`
Expected: FAIL because stale state is not auto-repaired before daemon access today.

**Step 3: Write minimal implementation**

Teach the daemon client to probe daemon state, auto-start for safe stale cases, and retry once after repair.

**Step 4: Run test to verify it passes**

Run: `bun test tests/daemon-client.test.ts`
Expected: PASS

### Task 4: Wire the new visibility through daemon surfaces

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/commands/daemon.ts`
- Modify: `src/commands/doctor.ts`

**Step 1: Write the failing test**

Extend existing tests where needed to assert reset summary fields and guided repair messages are surfaced in daemon-facing output.

**Step 2: Run test to verify it fails**

Run: `bun test tests/runtime-cache.test.ts tests/daemon-status.test.ts tests/daemon-client.test.ts`
Expected: FAIL until the new fields are exposed everywhere they are expected.

**Step 3: Write minimal implementation**

Expose reset summary/reasons in metrics and cached payloads, and update daemon/doctor messaging to use the richer report.

**Step 4: Run test to verify it passes**

Run: `bun test tests/runtime-cache.test.ts tests/daemon-status.test.ts tests/daemon-client.test.ts`
Expected: PASS

### Task 5: Run quality gates and session handoff

**Files:**
- Modify: `docs/plans/2026-03-13-daemon-runtime-reset-repair-design.md`
- Modify: `docs/plans/2026-03-13-daemon-runtime-reset-repair-plan.md`

**Step 1: Run focused verification**

Run: `bun test tests/runtime-cache.test.ts tests/daemon-status.test.ts tests/daemon-client.test.ts tests/daemon-command.test.ts`
Expected: PASS

**Step 2: Run repository quality checks**

Run: `bun x ultracite check`
Expected: PASS, or actionable diagnostics to fix

**Step 3: Capture follow-up**

If any unsafe or intentionally deferred path remains, file a `hack tickets` follow-up before ending the session.
